"""AURA's Shopping Agent: understands the request, remembers, reasons over the options, asks when it should.

    request -> intent -> preferences -> providers -> options -> decision engine -> ask / confirm / act -> learn

Per message it (1) reads it as an answer if AURA was waiting on one ("Zepto", "the cheaper one", "yes"), else works
out what the user wants against their own order history; (2) for an order, builds the real options across the
providers that sell it and lets the decision engine (app/shopping) choose between asking which store, asking for
one confirmation, or going ahead, under the user's purchase rules; (3) once decided, returns a `cartOrder` for the
phone's cart agent and records the decision so preferences keep learning; (4) forecasts what they'll need next.
It never invents prices or delivery times, and it stops at the cart: payment is the user's.
"""
from __future__ import annotations

import asyncio
import re
from collections import Counter

import pandas as pd
import structlog

from app.agents.base import BaseAgent
from app.ml.shopping_catalog import (APPS, CATALOG, CATEGORIES, FOOD_APPS, RESTAURANT_FOOD, canonical_app, canonical_item,
                                     dish_item, is_prepared_food, item_category, item_price)
from app.ml.shopping_predictor import get_predictor, now_ist, retrain_scheduler
from app.models.schemas import AgentResult
from app.services import shopping_service
from app.services.llm_service import LLMServiceError, llm_service
from app.services.shopping_browser import resolve_store
from app.services.shopping_history import ShoppingHistoryError, shopping_history
from app.services.shopping_memory import (_is_generic, _match_dish, history_for_llm, needs_sync, product_profile,
                                          resolve_items)
from app.shopping import engine
from app.shopping.policy import ShoppingPolicy
from app.shopping.preferences import DECISION, build_preferences
from app.shopping.providers import registry
from app.shopping.session import ShoppingSession, sessions

logger = structlog.get_logger()
INTENTS = {"order", "suggest", "search", "general"}

_INTENT_PROMPT = """You extract shopping commands for an Indian shopping assistant. Return JSON with exactly these keys:
{{"intent": "order" | "suggest" | "search" | "general",
  "store": store/app name exactly as the user said it, or null,
  "items": [{{"name": product as the user said it (keep brand/size), "qty": integer, "category": one of {cats} or null}}],
  "reorder_usual": true | false,
  "budget_inr": number or null}}
intent: order = wants something bought / added to cart / delivered now ("get me milk", "order eggs from zepto",
"add atta to my blinkit cart", "restock my usual"); suggest = asks what they need, what is running out, what to buy;
search = wants to find or compare products or prices without ordering; general = anything else.
reorder_usual = true when they ask for their usual / regular / the stuff they always buy / whatever is running out
instead of naming items. qty = how many packs/units to put in the cart, default 1: "2 packets of maggi" -> qty 2.
Sizes and counts that describe one pack go in the name, not qty: "a dozen eggs" -> name "eggs 12 pcs", qty 1;
"2 kg atta" -> name "atta 2 kg", qty 1; "two 1L milk" -> name "milk 1 L", qty 2. Known stores (others are fine
too): {apps}.

The user's past orders (item: the exact product they usually buy):
{history}
Relate the command to this history. When they point at it ("my usual milk", "same curd as last time", "what I
ordered last week", "breakfast stuff", "the bread I like"), use those exact past products as item names. A plain
item they have bought before ("milk", "curd") stays plain; it is matched to their usual product later. Never invent
items or a store the user did not say or that isn't in their history.
Commands are often spoken, so words can be misheard: when the store sounds like a known store ("zapdo", "zapto" ->
Zepto; "blink it", "blanket" -> Blinkit; "insta mart" -> Swiggy Instamart; "jomato" -> Zomato), return the known
store's name."""


def _fallback_intent(text: str) -> dict:
    """Used when the LLM is unavailable: '<verb> a, b x2 and c from <store>'."""
    lowered = text.lower().strip()
    lowered = re.sub(r"^\[shopping\]\s*", "", lowered)
    store = None
    m = re.search(r"\b(?:from|on|via|using)\s+([a-z][a-z .]{1,30})$", lowered)
    if m:
        store, lowered = m.group(1).strip(), lowered[: m.start()].strip()
    verb = re.match(r"^(?:please\s+)?(order|buy|get(?: me)?|add|reorder|restock|purchase)\b\s*", lowered)
    if verb:
        body = lowered[verb.end():]
        usual = bool(re.search(r"\b(usual|regular|always|running out|what i need)\b", body))
        items = []
        if not usual:
            for part in re.split(r",|\band\b|\n", body):
                part = re.sub(r"\b(to|in)\s+(my\s+)?cart\b", "", part).strip(" .")
                if not part:
                    continue
                q = re.match(r"^(\d+)\s*(?:x|packets? of|packs? of|kg of|of)?\s*(.+)$", part) or \
                    re.match(r"^(.+?)\s*[x×]\s*(\d+)$", part)
                if q and q.group(1).isdigit():
                    items.append({"name": q.group(2).strip(), "qty": int(q.group(1))})
                elif q:
                    items.append({"name": q.group(1).strip(), "qty": int(q.group(2))})
                else:
                    items.append({"name": part, "qty": 1})
        return {"intent": "order", "store": store, "items": items, "reorder_usual": usual or not items}
    if re.search(r"\b(what do i need|running out|what should i buy|suggest|need to buy)\b", lowered):
        return {"intent": "suggest", "store": store, "items": [], "reorder_usual": False}
    if re.search(r"\b(find|compare|search|price of|cheapest)\b", lowered):
        q = re.sub(r"^(find|compare|search( for)?|price of|cheapest)\s+", "", lowered)
        return {"intent": "search", "store": store, "items": [{"name": q, "qty": 1}], "reorder_usual": False}
    return {"intent": "general", "store": store, "items": [], "reorder_usual": False}


def _clean_items(raw) -> list[dict]:
    items = []
    for it in raw if isinstance(raw, list) else []:
        if not isinstance(it, dict) or not str(it.get("name") or "").strip():
            continue
        try:
            qty = max(1, min(int(it.get("qty") or 1), 50))
        except (TypeError, ValueError):
            qty = 1
        name = str(it["name"]).strip()[:80]
        cat = it.get("category") if it.get("category") in CATEGORIES else None
        items.append({"name": name, "qty": qty, "category": cat})
    return items[:25]


def _inr(x) -> str:
    return "n/a" if x is None else f"₹{x:,.0f}"


POLICY_COLLECTION, POLICY_ID = "shopping_policy", "policy"
_ORDER_VERB = re.compile(r"^(?:please\s+)?(order|buy|get|add|reorder|restock|purchase|find|compare|search)\b", re.I)
_BASKET_WORD = re.compile(r"\b(grocer(y|ies)|stuff|things|items|basket|essentials)\b", re.I)
_REFERS_BACK = re.compile(r"\b(one|it|that|this|same|them)\b", re.I)


def _store_in_message(message: str, store: str | None) -> str | None:
    """The store the user actually said. The intent model sometimes fills in their usual store from history; a
    store only counts as named (and skips the comparison) when its name is in the message, however it's spelt."""
    if not store:
        return None
    wanted = canonical_app(store)
    words = re.findall(r"[a-z0-9]+", message.lower())
    for n in (3, 2, 1):
        for i in range(len(words) - n + 1):
            if canonical_app(" ".join(words[i:i + n])) == wanted:
                return store
    # an unknown store written out in full by the model ("lulu" -> "Lulu Hypermarket"): its own word was said
    said = set(words)
    return store if any(w in said for w in re.findall(r"[a-z0-9]{3,}", store.lower())) else None


def _is_new_request(message: str) -> bool:
    """While a question is pending: 'order bread from blinkit' / 'get my usual groceries' start over, but
    'get the cheaper one' / 'buy it from zepto' answer the question."""
    if not _ORDER_VERB.search(message.strip()):
        return False
    words = re.findall(r"[a-z]+", message.lower())
    names_product = any(canonical_item(w) in CATALOG for w in words) or bool(_BASKET_WORD.search(message))
    return names_product and not (_REFERS_BACK.search(message) and len(words) <= 6 and not _BASKET_WORD.search(message))


async def load_policy(user_id: str | None) -> ShoppingPolicy:
    if not user_id or user_id == "anonymous":
        return ShoppingPolicy()
    try:
        doc = await shopping_history.get_doc(user_id, POLICY_COLLECTION, POLICY_ID)
        return ShoppingPolicy(**doc) if doc else ShoppingPolicy()
    except (ShoppingHistoryError, ValueError) as exc:
        logger.warning("shopping_policy_unavailable", error=str(exc)[:200])
        return ShoppingPolicy()


async def save_policy(user_id: str, policy: ShoppingPolicy) -> None:
    await shopping_history.set_doc(user_id, POLICY_COLLECTION, POLICY_ID, policy.model_dump())


class ShoppingAgent(BaseAgent):
    name = "shopping"

    async def run(self, situation: str, context: dict) -> AgentResult:
        user_id = context.get("userId")
        as_of = pd.Timestamp(context["asOf"]) if context.get("asOf") else now_ist()
        message = re.sub(r"\n\nContext from the user's data:.*", "", situation, flags=re.S)
        message = re.sub(r"\n\n\(Reply style:.*", "", message, flags=re.S)
        message = re.sub(r"^\s*\[shopping\]\s*", "", message)
        events = await self._events(user_id)

        # an answer to the question AURA just asked ("Zepto", "the cheaper one", "yes")
        session = sessions.get(user_id) if user_id else None
        if session and session.pending:
            answered = await self._answer(session, message, user_id, events, context)
            if answered is not None:
                return answered

        memory = product_profile(events) if events else []
        intent = await self._intent(message, memory)
        kind = intent.get("intent") if intent.get("intent") in INTENTS else "general"
        items = _clean_items(intent.get("items"))
        store_said = _store_in_message(message, (intent.get("store") or "").strip() or None)
        notes: list[str] = []
        constraints: list[str] = []
        options: list[str] = []
        data: dict = {"intent": {**intent, "items": items}, "usualProducts": memory[:15]}

        predictor = get_predictor()
        profile = await asyncio.to_thread(predictor.predict, events, as_of, [i["name"] for i in items]) \
            if user_id else None
        data["predictions"] = profile
        preds = (profile or {}).get("nextPurchases") or []

        # ---- order: understand -> remember -> options -> decide -> ask or act ----
        if kind == "order":
            if not items:
                items = [{"name": p["item"], "qty": p["usualQty"], "category": p["category"]} for p in preds[:8]]
            if not items:
                say = "What would you like me to order? I don't have enough of your order history yet to guess."
                data["assist"] = {"say": say, "pending": False, "options": []}
                data["directReply"] = say
                constraints.append("Nothing to order: no items named and no purchase history to predict from.")
            else:
                return await self._propose(user_id, message, items, store_said, events, context, data)

        # ---- search: live prices ----
        elif kind == "search" and items:
            q = items[0]["name"]
            await self._log(user_id, [{"action": "search", "name": q, "item": canonical_item(q),
                                       "app": canonical_app(store_said) if store_said else "AURA",
                                       "source": "agent_command"}], data, "search command")
            try:
                found = await shopping_service.search_products(q, max_results=6)
                data["products"] = [p.model_dump() for p in found[:6]]
                priced = [p for p in found if p.price]
                if priced:
                    notes.append(f"Live prices for '{q}', cheapest first: " + "; ".join(
                        f"{p.title[:60]} {_inr(p.price)} at {p.source}" for p in priced[:4]))
                else:
                    notes.append(f"No priced listings found for '{q}'.")
            except shopping_service.ShoppingServiceError as exc:
                constraints.append(f"Live price search unavailable: {exc}")
            options.append(f"Say 'order {q}' and AURA will find where to get it and ask before adding it to a cart.")

        elif kind in ("suggest", "general") and user_id:
            await self._log(user_id, [], data, f"{kind} command")

        # ---- what the model expects them to need ----
        if preds:
            lines = [f"{p['item']} ({round(p['probability'] * 100)}%"
                     + (f", due in ~{p['dueInDays']:.0f}d" if p.get("dueInDays") is not None else "")
                     + (f", usually {p['store']}" if p.get("store") else "") + ")" for p in preds[:6]]
            notes.append("Model forecast, likely to be bought in the next 7 days (suggestions, not certainties): "
                         + "; ".join(lines) + ".")
            for b in (profile or {}).get("suggestedBaskets", [])[:2]:
                if b.get("store"):
                    options.append(f"Reorder from {b['store']}: " + ", ".join(i["name"] for i in b["items"])
                                   + f" (~{_inr(b['estimatedAmountInr'])})")
        elif profile and profile.get("status") == "cold_start":
            notes.append("No past orders on record yet, so there is no personalised shopping forecast.")
        hist = (profile or {}).get("history") or {}
        if hist.get("favouriteStores"):
            notes.append("Shopping habits: mostly " + ", ".join(s["store"] for s in hist["favouriteStores"])
                         + (f"; average order {_inr(hist['averageOrderValueInr'])}" if hist.get("averageOrderValueInr") else "")
                         + ".")

        return AgentResult(agent=self.name, status="completed", insights=["\n".join(notes)] if notes else [],
                           constraints=constraints, options=options, data=data)

    # ------------------------------------------------------------------ propose
    async def _propose(self, user_id: str | None, message: str, items: list[dict], store_said: str | None,
                       events: list[dict], context: dict, data: dict) -> AgentResult:
        prefs = build_preferences(events)
        policy = await load_policy(user_id)
        named = canonical_app(store_said) if store_said else None
        dishes = [p for p in product_profile(events) if p["category"] == RESTAURANT_FOOD]
        prepared = bool(items) and all(is_prepared_food(i["name"]) for i in items)
        if named == "Swiggy" and not prepared and not all(_match_dish(i["name"], dishes) for i in items):
            named = "Swiggy Instamart"   # "milk from Swiggy" means its grocery side
        food = bool(named in FOOD_APPS or (not named and (prepared or all(_match_dish(i["name"], dishes) for i in items))))

        basket, explicit = [], True
        for i in items:
            if food:
                d = _match_dish(i["name"], dishes)
                key = dish_item(d["product"]) if d else dish_item(i["name"])
            else:
                key = canonical_item(i["name"])
            pref = prefs.items.get(key)
            explicit = explicit and not _is_generic(i["name"])
            basket.append({"name": i["name"], "qty": i["qty"], "item": key, "known": bool(pref and pref.known),
                           "usual": pref.product if pref else None})
        category = RESTAURANT_FOOD if food else item_category(basket[0]["item"])

        providers = registry.for_category(category, set(context.get("installedStores") or []) or None)
        if named and named not in {p.name for p in providers} and registry.get(named):
            providers.append(registry.get(named))
        session = sessions.start(user_id or "anonymous")
        session.items, session.category = basket, category
        session.criterion = engine.criterion_in(message) or ("usual" if data["intent"].get("reorder_usual") else None)
        session.options = engine.rank(engine.build_options(basket, providers, prefs, category=category), prefs,
                                      session.criterion)
        decision = engine.decide(session, prefs, policy, named=named, explicit_product=explicit)
        data["providers"] = [{"provider": o.provider, "status": "searched" if o.source == "live_app" else "not_checked",
                              "source": o.source} for o in session.options]
        if decision.action == "execute":
            return await self._execute(session, decision, user_id, events, data, criterion=session.criterion or
                                       ("named" if named else "rule"))
        return self._reply(session, decision, data)

    # ------------------------------------------------------------------ answer
    async def _answer(self, session: ShoppingSession, message: str, user_id: str, events: list[dict],
                      context: dict) -> AgentResult | None:
        """Reads the reply to the pending question. None = it wasn't an answer (treat as a new request)."""
        if _is_new_request(message):
            sessions.clear(session.user_id)
            return None
        kind, value = engine.interpret(message, session)
        prefs = build_preferences(events)
        data: dict = {}
        session.touch()
        if kind == "no":
            sessions.clear(session.user_id)
            say = "Okay, I won't add anything."
            return AgentResult(agent=self.name, status="completed", insights=[say],
                               data={"assist": {"say": say, "pending": False, "options": []}, "directReply": say})
        if kind == "choose":
            session.provider = value.provider
            return await self._execute(session, engine.Decision("execute", f"Got it. I'll use {value.label}.",
                                                                provider=value.provider), user_id, events, data,
                                       criterion="named")
        if kind == "criterion":
            session.criterion = value
            session.options = engine.rank(session.options, prefs, value)
            if value == "usual":
                usual = session.options[0] if session.options and session.options[0].preferred > 0 else None
                picked, note = usual, (f"You usually get this from {usual.label}." if usual else "")
            else:
                picked, note = engine.pick_by(value, session.options)
            if picked:
                session.provider = picked.provider
                return await self._execute(session, engine.Decision("execute", f"{note} I'll use {picked.label}.",
                                                                    provider=picked.provider), user_id, events, data,
                                           criterion=value)
            what = "prices" if value == "cheapest" else "delivery times" if value == "fastest" else "a usual store for this"
            say = f"I don't have {what} to go on yet. {session.question}"
            return self._reply(session, engine.Decision("ask", say), data)
        if kind == "any" or (kind == "yes" and session.pending == "choose_provider" and len(session.options) == 1):
            top = session.options[0]
            session.provider = top.provider
            return await self._execute(session, engine.Decision("execute", f"I'll go with {top.label}.",
                                                                provider=top.provider), user_id, events, data,
                                       criterion="default")
        if kind == "yes":
            if session.pending == "confirm" and session.provider:
                label = session.provider
                return await self._execute(session, engine.Decision("execute", f"Got it. I'll use {label}.",
                                                                    provider=label), user_id, events, data,
                                           criterion=session.criterion or "usual")
            names = " or ".join(o.label for o in session.options[:3])
            return self._reply(session, engine.Decision("ask", f"Sure. Which store: {names}?"), data)
        return self._reply(session, engine.Decision("ask", f"Sorry, I didn't get that. {session.question}"), data)

    # ------------------------------------------------------------------ act
    async def _execute(self, session: ShoppingSession, decision, user_id: str | None, events: list[dict],
                       data: dict, criterion: str) -> AgentResult:
        """The decision is made (confirmed, chosen, or pre-approved): hand a cart job to the phone and learn from it."""
        resolved = resolve_store(session.provider)
        items = [{"name": i["name"], "qty": i["qty"]} for i in session.items]
        sync = needs_sync(events, resolved["name"]) and bool(resolved.get("androidPackage") or resolved["known"])
        matched: list[str] = []
        if not sync:
            items, matched = resolve_items(items, product_profile(events, store=resolved["name"]), store=resolved["name"])
        cart_items = [{"name": i["name"], "qty": i["qty"], **({"hint": i["hint"]} if i.get("hint") else {})}
                      for i in items]
        data["cartOrder"] = {"store": resolved["name"], "storeKey": resolved["key"], "startUrl": resolved["startUrl"],
                             "androidPackage": resolved["androidPackage"], "appLabel": resolved["appLabel"],
                             "items": cart_items, "autoStart": True, "syncHistory": sync, "resolved": not sync}
        basket = ", ".join(f"{i['name']}{' x' + str(i['qty']) if i['qty'] > 1 else ''}" for i in cart_items)
        say = f"{decision.say} Adding {basket} to your {resolved['name']} cart. I stop at the cart; you pay."
        if sync:
            say += f" First I'll read your past {resolved['name']} orders so I pick your usual products."
        # learn: what was on the table and what they picked (one record per item), plus the intent itself
        ts = now_ist().isoformat()
        offered = [{"provider": o.provider, "final_cost": o.final_cost, "eta_minutes": o.eta_minutes, "source": o.source}
                   for o in session.options[:engine.MAX_OPTIONS]]
        records = [{"action": DECISION, "timestamp": ts, "item": i["item"], "name": i["name"],
                    "chosen": resolved["name"], "criterion": criterion, "options": offered, "source": "decision"}
                   for i in session.items]
        intents = [{"action": "add_to_cart", "name": c["name"], "qty": c["qty"], "app": resolved["name"],
                    "category": session.category if session.category == RESTAURANT_FOOD else None,
                    "price": item_price(canonical_item(c["name"])) or 0.0, "source": "agent_command"} for c in cart_items]
        await self._log(user_id, records + intents, data, f"order ({len(cart_items)} items, {criterion})")
        sessions.clear(session.user_id)
        data["assist"] = {"say": say, "pending": False, "options": [], "level": decision.level,
                          "provider": resolved["name"], "matched": matched}
        data["directReply"] = say
        return AgentResult(agent=self.name, status="completed", insights=[say], data=data)

    def _reply(self, session: ShoppingSession, decision, data: dict) -> AgentResult:
        if decision.action != "ask":
            sessions.clear(session.user_id)
        shown = session.options[:engine.MAX_OPTIONS] if session.pending == "choose_provider" else []
        data["assist"] = {"say": decision.say, "pending": bool(session.pending) and decision.action == "ask",
                          "question": session.pending, "level": decision.level, "reasons": decision.reasons,
                          "options": [o.to_dict() for o in shown],
                          "quickReplies": ([o.label for o in shown] if shown else ["Yes", "No"])
                          if decision.action == "ask" else []}
        data["directReply"] = decision.say
        return AgentResult(agent=self.name, status="completed", insights=[decision.say], data=data,
                           required_approval=decision.action == "ask")

    async def _events(self, user_id: str | None) -> list[dict]:
        if not user_id:
            return []
        try:
            return await shopping_history.get_events(user_id)
        except ShoppingHistoryError as exc:
            logger.warning("shopping_history_unavailable", error=str(exc))
            return []

    async def _log(self, user_id: str | None, events: list[dict], data: dict, reason: str) -> None:
        """Every command is learning signal: store its events, then schedule a (debounced) retrain."""
        if not user_id or user_id == "anonymous":  # no signed-in user: nothing to learn into
            return
        ts = now_ist().isoformat()
        try:
            data["logged"] = await shopping_history.add_events(user_id, [{"timestamp": ts, **e} for e in events])
        except ShoppingHistoryError as exc:
            logger.warning("shopping_event_log_failed", error=str(exc))
            data["logged"] = "failed"
        data["retrain"] = retrain_scheduler.request(reason)

    async def _intent(self, text: str, memory: list[dict] | None = None) -> dict:
        try:
            out = await llm_service.chat_json([
                {"role": "system", "content": _INTENT_PROMPT.format(cats=", ".join(CATEGORIES), apps=", ".join(APPS),
                                                                    history=history_for_llm(memory or []))},
                {"role": "user", "content": text},
            ], max_tokens=500)
            return out if isinstance(out, dict) else _fallback_intent(text)
        except LLMServiceError as exc:
            logger.warning("shopping_intent_llm_failed", error=str(exc))
            return _fallback_intent(text)
