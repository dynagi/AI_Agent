"""Answers about the user's past orders from the orders AURA has actually read: the store apps' own "Your orders"
pages (source "store_history", read on the phone during a cart run or "learn from my orders") and imported invoices
(source "invoice"). Store apps have no public order API, so nothing else is available; AURA never guesses an order,
a date or a total, and says plainly when it hasn't read a store's orders yet.

  "what did I order last time?"            -> the latest order: store, date, items, total if prices were read
  "show my recent Blinkit orders"          -> the last few Blinkit orders
  "what was the total of my previous order" -> that order's total, or that the prices weren't shown
  "did I order milk before?"               -> yes with the last date, or not in the orders read
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime

from app.ml.shopping_catalog import canonical_app

REAL = {"store_history", "invoice"}          # AURA carts and voice commands are intents, not orders

ASKS = re.compile(r"\b(?:what did i (?:order|buy|get)|my (?:\w+ )?(?:last|previous|recent|past|latest)? ?(?:\w+ )?orders?\b(?! (?:milk|food|pizza|from))|"
                  r"(?:last|previous|recent|past|latest) (?:\w+ )?orders?|order history|"
                  r"did i (?:ever )?(?:order|buy) .+? (?:before|earlier|last)|have i (?:ever )?(?:ordered|bought))\b", re.I)
# an order on its way is not history: AURA can't see live delivery status, so the chat says so instead
_LIVE = re.compile(r"\b(track|tracking|where is|status|arriving|delivered yet|on the way|eta)\b", re.I)
_TOTAL = re.compile(r"\b(total|how much did i (?:pay|spend)|amount|cost|bill)\b", re.I)
_BEFORE = re.compile(r"\b(?:did|have) i (?:ever )?(?:order|buy|ordered|bought)\s+(?:any\s+|some\s+)?(.+?)"
                     r"(?:\s+(?:before|earlier|last time|ever|from \w+))*\s*[?.!]*$", re.I)
_STORES = ("blinkit", "zepto", "zomato", "swiggy", "instamart", "bigbasket", "amazon", "flipkart", "dominos",
           "domino's", "jiomart", "dmart", "myntra")


@dataclass
class Order:
    app: str
    day: str
    items: list[tuple[str, int, float | None]] = field(default_factory=list)

    @property
    def total(self) -> float | None:
        prices = [p for _, _, p in self.items]
        return sum(prices) if prices and all(p is not None for p in prices) else None


def orders(events: list[dict]) -> list[Order]:
    """Real past orders, newest first, grouped by store and order number (or store and day without one)."""
    groups: dict[tuple, Order] = {}
    for e in events:
        if e.get("action") != "order" or e.get("source") not in REAL or not e.get("name"):
            continue
        app = canonical_app(e.get("app")) if e.get("app") else "a store"
        day = str(e.get("timestamp") or "")[:10]
        key = (app, str(e.get("orderId") or day))
        o = groups.setdefault(key, Order(app=app, day=day))
        try:
            price = float(e["price"]) if e.get("price") not in (None, "") else None
        except (TypeError, ValueError):
            price = None
        o.items.append((str(e["name"]), int(e.get("qty") or 1), price))
    return sorted(groups.values(), key=lambda o: o.day, reverse=True)


def _when(day: str) -> str:
    try:
        return datetime.strptime(day, "%Y-%m-%d").strftime("%d %B %Y").lstrip("0")
    except ValueError:
        return "an unknown date"


def _rupees(x: float) -> str:
    return f"₹{x:,.0f}" if float(x).is_integer() else f"₹{x:,.2f}"


def _items(o: Order, limit: int = 5) -> str:
    names = [f"{q} × {n}" if q > 1 else n for n, q, _ in o.items[:limit]]
    more = f" and {len(o.items) - limit} more" if len(o.items) > limit else ""
    return ", ".join(names) + more


def _store_in(text: str) -> str | None:
    t = text.lower()
    for s in _STORES:
        if re.search(rf"\b{re.escape(s)}\b", t):
            return canonical_app(s)
    words = re.findall(r"[a-z]+", t)
    for w in words:                       # "blanket orders": a misheard store name in an orders question
        c = canonical_app(w)
        if c in {canonical_app(s) for s in _STORES}:
            return c
    return None


def answer(text: str, events: list[dict]) -> str | None:
    """A reply when the message asks about past orders; None when it doesn't."""
    if not ASKS.search(text or "") or _LIVE.search(text or ""):
        return None
    store = _store_in(text)
    past = [o for o in orders(events) if store is None or o.app == store]
    where = f" {store}" if store else ""
    if not past:
        return (f"I haven't read any of your{where} orders yet, so I can't tell you. Say \"learn from my{where or ' Blinkit'} "
                "orders\" and I'll read them from the app on your phone (you need to be logged in there).")
    m = _BEFORE.search(text)
    if m and not re.search(r"\b(last time|previous order|last order)\b", text, re.I) and m.group(1).strip():
        thing = re.sub(r"^(?:a|an|the|this item|this)\s+", "", m.group(1).strip().lower())
        hits = [(o, n) for o in past for n, _, _ in o.items if thing and thing in n.lower()]
        if not hits:
            return f"I don't see {thing} in the {len(past)} {where.strip() + ' ' if where else ''}orders I've read."
        o, n = hits[0]
        return f"Yes: {n}, last on {_when(o.day)} from {o.app}." + (f" That's {len(hits)} times in the orders I've read." if len(hits) > 1 else "")
    last = past[0]
    if _TOTAL.search(text):
        if last.total is None:
            return (f"Your last{where} order was on {_when(last.day)} from {last.app}, but the app didn't show all the "
                    "prices when I read it, so I can't give you a total.")
        return f"Your last{where} order, on {_when(last.day)} from {last.app}, came to {_rupees(last.total)}."
    if re.search(r"\b(recent|orders|history|past)\b", text, re.I) and len(past) > 1:
        rows = "; ".join(f"{_when(o.day)}: {_items(o, 3)}" for o in past[:3])
        return f"Your last {min(3, len(past))}{where} orders: {rows}."
    total = f", {_rupees(last.total)} in total" if last.total is not None else ""
    return f"Your last order was from {last.app} on {_when(last.day)}: {_items(last)}{total}."
