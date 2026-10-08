"""The decision engine: from a request plus what we know, to "ask which", "ask to confirm" or "go ahead".

Inputs: the items, the user's preferences (with confidence), the providers that could sell them, any real offers,
and the user's purchase rules. Output: one decision and the sentence to say. It also reads the user's reply to a
pending question.

Autonomy levels:
  1  new / unknown product           -> always ask (which store; nothing is assumed)
  2  known product, usual store      -> one confirmation; or none when the user named product and store themselves
  3  pre-approved repeat order rule  -> go ahead, inside the rule's limits only

It only compares what it really has. A store whose price wasn't read says "not checked"; a price from the user's own
last order is labelled as such. "Cheapest" or "fastest" without the data to back it is answered honestly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.ml.shopping_catalog import canonical_app
from app.shopping.policy import ShoppingPolicy, auto_rule, confirmation_reasons
from app.shopping.preferences import ShoppingPreferences
from app.shopping.providers import Offer, ShoppingProvider
from app.shopping.session import Option, ShoppingSession

MAX_OPTIONS = 4
_YES = re.compile(r"^(yes|yeah|yep|yup|ya|ok|okay|sure|fine|go ahead|do it|proceed|confirm|please do|haan|ha|han|"
                  r"theek hai|thik hai|kar do|add it|go for it|sounds good|alright)\b", re.I)
_NO = re.compile(r"^(no|nope|nah|cancel|stop|don'?t|do not|nahi|nahin|leave it|never ?mind|forget it|not now)\b", re.I)
_CHEAP = re.compile(r"\b(cheap(er|est)?|lowest|least|low(er)? price|sasta|budget)\b", re.I)
_FAST = re.compile(r"\b(fast(er|est)?|quick(ly|er|est)?|soon(er|est)?|earliest|urgent(ly)?|right now|asap|jaldi|"
                   r"immediately)\b", re.I)
_USUAL = re.compile(r"\b(usual|same as (last|before)|same one|like (last time|before)|regular|as always|"
                    r"what(ever)? i (usually|normally|always) (buy|get|order))\b", re.I)
_ANY = re.compile(r"\b(don'?t care|whatever|any(thing| one| of them)?|you (choose|decide|pick)|either|up to you|"
                  r"just order( it)?|koi bhi)\b", re.I)
_ORDINAL = {"first": 0, "1st": 0, "second": 1, "2nd": 1, "third": 2, "3rd": 2, "fourth": 3, "4th": 3}
_NUMBERED = re.compile(r"\b(?:option|number|no\.?)\s*(one|two|three|four|[1-4])\b", re.I)
_NUMBER_WORD = {"one": 0, "1": 0, "two": 1, "2": 1, "three": 2, "3": 2, "four": 3, "4": 3}


@dataclass
class Decision:
    action: str                       # ask | execute | cancel | inform
    say: str
    level: int = 1
    provider: str | None = None
    reasons: list[str] = field(default_factory=list)   # why this needs a yes / why this option
    explain: dict = field(default_factory=dict)


def criterion_in(text: str) -> str | None:
    """What the user asked to optimise for, if they said."""
    if _CHEAP.search(text):
        return "cheapest"
    if _FAST.search(text):
        return "fastest"
    if _USUAL.search(text):
        return "usual"
    return None


def _inr(x: float | None) -> str:
    return "" if x is None else f"₹{x:,.0f}"


# ---------------------------------------------------------------------------------- options
def build_options(items: list[dict], providers: list[ShoppingProvider], prefs: ShoppingPreferences,
                  quotes: dict[str, list[Offer]] | None = None, category: str | None = None) -> list[Option]:
    """One option per provider that could fill this basket, with whatever real numbers exist for it."""
    quotes = quotes or {}
    options = []
    for p in providers:
        total, sources, dates, eta, complete = 0.0, set(), [], None, True
        preferred = []
        for it in items:
            pref = prefs.items.get(it["item"])
            if pref and pref.provider:
                # share of this item's purchases/choices made here, damped by how much evidence there is
                evidence = pref.provider_confidence / max(pref.providers.get(pref.provider, 1.0), 1e-6)
                preferred.append(pref.providers.get(p.name, 0.0) * evidence)
            else:
                # never bought: a weak nudge towards where they buy this kind of thing
                preferred.append(0.2 if category and prefs.provider_by_category.get(category) == p.name else 0.0)
            live = next((o for o in quotes.get(p.name, []) if o.price is not None), None)
            if live:
                total += live.final_cost or 0.0
                sources.add(live.source)
                eta = live.eta_minutes if live.eta_minutes is not None else eta
            elif pref and p.name in pref.last_price:
                total += pref.last_price[p.name]["price"] * it["qty"]
                sources.add("your_last_order")
                dates.append(pref.last_price[p.name]["date"])
            else:
                complete = False
        known_cost = complete and bool(sources)
        options.append(Option(
            provider=p.name, label=p.name, kind=p.label,
            final_cost=round(total, 2) if known_cost else None, eta_minutes=eta,
            source=("live_app" if sources == {"live_app"} else "your_last_order" if known_cost else "not_checked"),
            observed=min(dates) if dates and known_cost else None,
            preferred=round(sum(preferred) / len(preferred), 3) if preferred else 0.0))
    return options


def rank(options: list[Option], prefs: ShoppingPreferences, criterion: str | None = None) -> list[Option]:
    """Order by the user's stated criterion, else by their habits weighed with their learnt price/speed trade-off.
    Missing numbers never count as good: an option without a price can't win on price."""
    costs = [o.final_cost for o in options if o.final_cost is not None]
    etas = [o.eta_minutes for o in options if o.eta_minutes is not None]
    lo_c, hi_c = (min(costs), max(costs)) if costs else (0, 0)
    lo_e, hi_e = (min(etas), max(etas)) if etas else (0, 0)
    for o in options:
        price_s = 0.0 if o.final_cost is None else 1.0 if hi_c == lo_c else 1 - (o.final_cost - lo_c) / (hi_c - lo_c)
        speed_s = 0.0 if o.eta_minutes is None else 1.0 if hi_e == lo_e else 1 - (o.eta_minutes - lo_e) / (hi_e - lo_e)
        if criterion == "cheapest":
            o.score = price_s + 0.01 * o.preferred if o.final_cost is not None else -1 + 0.01 * o.preferred
        elif criterion == "fastest":
            quick = 0.5 if "quick" in o.kind else 0.0   # a quick-delivery app, when no delivery time was read
            o.score = (1 + speed_s if o.eta_minutes is not None else quick) + 0.01 * o.preferred
        elif criterion == "usual":
            o.score = o.preferred
        else:
            o.score = 0.6 * o.preferred + 0.4 * (prefs.price_weight * price_s + prefs.speed_weight * speed_s)
        o.score = round(o.score, 4)
    return sorted(options, key=lambda o: -o.score)


def describe(o: Option) -> str:
    bits = [o.label]
    if o.final_cost is not None:
        bits.append(f"{_inr(o.final_cost)} live" if o.source == "live_app"
                    else f"you last paid {_inr(o.final_cost)} there" + (f" ({o.observed})" if o.observed else ""))
    else:
        bits.append("price not checked yet")
    if o.eta_minutes is not None:
        bits.append(f"about {o.eta_minutes} min")
    return " — ".join(bits)


def _basket(items: list[dict]) -> str:
    """The basket in words; a known item is named as the product they usually buy."""
    return ", ".join(f"{i.get('usual') or i['name']}{' x' + str(i['qty']) if i['qty'] > 1 else ''}" for i in items)


# ---------------------------------------------------------------------------------- deciding
def decide(session: ShoppingSession, prefs: ShoppingPreferences, policy: ShoppingPolicy, *, named: str | None,
           explicit_product: bool) -> Decision:
    """What to do next for the session's basket. Sets the session's pending question when it asks."""
    items, options = session.items, session.options
    known = all(i.get("known") for i in items)
    level = 2 if known else 1
    if not options:
        return Decision("inform", f"I don't know a store that sells {_basket(items)} yet.", level)

    by_name = {o.provider: o for o in options}
    top = options[0]
    chosen = by_name.get(canonical_app(named)) if named else None
    if named and chosen is None:  # a store we know nothing about: still allowed, just unverified
        chosen = Option(provider=named, label=named)

    def needs(o: Option) -> list[str]:
        unit = (o.final_cost / sum(i["qty"] for i in items)) if o.final_cost is not None and len(items) == 1 else None
        typical = prefs.items[items[0]["item"]].typical_price if len(items) == 1 and items[0]["item"] in prefs.items else None
        return confirmation_reasons(policy, known=known, total=o.final_cost, unit_price=unit, typical_price=typical)

    def rule_for(o: Option):
        if len(items) != 1:
            return None
        unit = o.final_cost / items[0]["qty"] if o.final_cost is not None else None
        return auto_rule(policy, item=items[0]["item"], provider=o.provider, qty=items[0]["qty"], unit_price=unit,
                         known=known)

    # Level 3: a rule the user set up in advance covers exactly this
    for candidate in ([chosen] if chosen else options):
        rule = rule_for(candidate)
        if rule and (chosen or rule.provider or candidate.preferred >= policy.min_provider_confidence):
            session.provider, session.pending = candidate.provider, None
            return Decision("execute", f"Adding your usual {_basket(items)} on {candidate.label}, as set in your "
                                       "auto-order rule.", 3, candidate.provider, explain={"rule": True})

    # the user named the store
    if chosen:
        reasons = needs(chosen)
        session.provider = chosen.provider
        if not reasons:
            session.pending = None
            return Decision("execute", f"Got it. I'll add {_basket(items)} on {chosen.label}.", level, chosen.provider)
        session.pending, session.reasons = "confirm", reasons
        session.question = f"Shall I add {_basket(items)} on {chosen.label}?"
        return Decision("ask", f"{describe(chosen)}. I'm checking because {reasons[0]}. {session.question}", level,
                        chosen.provider, reasons)

    # their usual store for this, with enough evidence: one yes
    if known and top.preferred >= policy.min_provider_confidence and session.criterion in (None, "usual"):
        session.provider, session.pending = top.provider, "confirm"
        session.question = "Shall I add it to your cart?"
        others = [o for o in options[1:MAX_OPTIONS] if o.final_cost is not None]
        also = f" ({'; '.join(describe(o) for o in others)}.)" if others else ""
        return Decision("ask", f"Your usual {_basket(items)}: {describe(top)}, where you normally get it.{also} "
                               f"{session.question}", level, top.provider, explain={"confidence": top.preferred})

    # a criterion we can honour with real numbers
    if session.criterion in ("cheapest", "fastest"):
        picked, note = pick_by(session.criterion, options)
        if picked:
            session.provider, session.pending = picked.provider, "confirm"
            session.question = f"Shall I use {picked.label}?"
            return Decision("ask", f"{note} {session.question}", level, picked.provider)

    # otherwise: show the real options and ask
    shown = options[:MAX_OPTIONS]
    session.pending, session.provider = "choose_provider", None
    intro = (f"I can get your usual {_basket(items)} from {len(shown)} stores" if known
             else f"{_basket(items)} isn't something I've seen you buy, so I won't assume. I can get it from")
    lines = "; ".join(describe(o) for o in shown)
    unchecked = sum(1 for o in shown if o.final_cost is None)
    caveat = " I haven't read live prices yet, so I can't say which is cheapest." if unchecked == len(shown) else ""
    session.question = "Which one should I use?"
    sep = ": " if known else " "
    return Decision("ask", f"{intro}{sep}{lines}.{caveat} {session.question}", level)


def pick_by(criterion: str, options: list[Option]) -> tuple[Option | None, str]:
    """The cheapest / fastest option that the data can actually support, with an honest sentence about it."""
    if criterion == "cheapest":
        priced = sorted((o for o in options if o.final_cost is not None), key=lambda o: o.final_cost)
        if len(priced) >= 2:
            a, b = priced[0], priced[1]
            basis = "live prices" if a.source == b.source == "live_app" else "what you last paid at each"
            return a, f"{a.label} is cheaper at {_inr(a.final_cost)} against {_inr(b.final_cost)} on {b.label}, going by {basis}."
        if len(priced) == 1:
            return priced[0], (f"I only have a price for {priced[0].label} ({_inr(priced[0].final_cost)}, "
                               f"{'live' if priced[0].source == 'live_app' else 'from your last order'}); "
                               "I haven't checked the others, so I can't promise it's the cheapest.")
        return None, ""
    timed = sorted((o for o in options if o.eta_minutes is not None), key=lambda o: o.eta_minutes)
    if timed:
        return timed[0], f"{timed[0].label} is fastest at about {timed[0].eta_minutes} minutes."
    quick = [o for o in options if "quick" in o.kind]
    if quick:
        best = max(quick, key=lambda o: o.preferred)
        return best, (f"I haven't read delivery times live, but {best.label} is a quick-delivery app"
                      f"{' you already use' if best.preferred > 0 else ''}.")
    return None, ""


# ---------------------------------------------------------------------------------- reading the answer
def interpret(text: str, session: ShoppingSession) -> tuple[str, Option | str | None]:
    """The user's reply to the pending question -> (kind, value):
    ('choose', Option) | ('criterion', 'cheapest'|'fastest'|'usual') | ('any', None) | ('yes', None) | ('no', None)
    | ('unknown', None)."""
    t = re.sub(r"\s+", " ", text.strip().lower())
    t = re.sub(r"^\[shopping\]\s*", "", t)
    options = session.options
    # a store by name (also how speech writes it: "zapdo", "blink it")
    for o in options:
        if o.label.lower() in t:
            return "choose", o
    words = t.split()
    for n in (3, 2, 1):
        for i in range(len(words) - n + 1):
            name = canonical_app(" ".join(words[i:i + n]))
            match = next((o for o in options if o.label == name), None)
            if match:
                return "choose", match
    # "the ₹67 one"
    for num in re.findall(r"\d+(?:\.\d+)?", t):
        match = next((o for o in options if o.final_cost is not None and abs(o.final_cost - float(num)) < 1), None)
        if match:
            return "choose", match
    if session.pending == "choose_provider":
        numbered = _NUMBERED.search(t)
        idx = _NUMBER_WORD[numbered.group(1).lower()] if numbered else next(
            (i for word, i in _ORDINAL.items() if re.search(rf"\b{word}\b", t)), None)
        if idx is not None and idx < len(options):
            return "choose", options[idx]
    # most specific first: a criterion ("whatever I usually buy"), then "anything is fine" ("don't care, just
    # order it" is not a refusal), then a plain no / yes
    c = criterion_in(t)
    if c:
        return "criterion", c
    if _ANY.search(t):
        return "any", None
    if _NO.search(t):
        return "no", None
    if _YES.search(t):
        return "yes", None
    return "unknown", None
