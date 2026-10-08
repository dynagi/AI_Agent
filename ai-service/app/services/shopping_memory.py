"""The user's own product memory, built from their order history.

History comes from two places: orders AURA reads from the store apps' own "Your orders" screens (the cart agent's
history phase, source="store_history"), and carts AURA filled for them (source="cart_agent"). From it:
  * product_profile  - per item, the exact product they usually buy (brand/size), usual qty, store, how recently;
  * resolve_items    - turns a command's generic items ("milk") into their usual product ("Amul Taaza Toned Milk
                       500 ml" x2), keeping anything the user spelled out themselves;
  * save_imported    - stores orders read from a store app (deduplicated), and marks the store as synced;
  * needs_sync       - whether a store's order history should be (re)read before ordering from it.
"""
from __future__ import annotations

import re
import uuid
from difflib import SequenceMatcher
from datetime import date, timedelta

import numpy as np
import pandas as pd

from app.ml.shopping_catalog import (CATALOG, FOOD_APPS, RESTAURANT_FOOD, canonical_app, canonical_item, dish_item,
                                     item_category)
from app.ml.shopping_features import normalize_events

SYNC_MARKER = "history_sync"  # not a model action (normalize_events drops it); records when a store was read
SYNC_EVERY_DAYS = 7
_GENERIC_MAX_WORDS = 2


def product_profile(events: list[dict], store: str | None = None, limit: int = 30) -> list[dict]:
    """Per item the user has ordered: their usual product, usual qty, store, count and recency (most bought first)."""
    ev = normalize_events(events)
    orders = ev[ev["action"] == "order"]
    if orders.empty:
        return []
    now = ev["timestamp"].max()
    out = []
    for item, g in orders.groupby("item"):
        age = (now - g["timestamp"]).dt.days.clip(lower=0).to_numpy()
        weight = np.exp(-age / 60.0)
        names = pd.Series(weight, index=g["name"].str.strip()).groupby(level=0).sum().sort_values(ascending=False)
        at_store = g[g["app"] == canonical_app(store)] if store else g
        apps = g["app"][~g["app"].isin(["none", "AURA"])].value_counts()
        store_names = (pd.Series(np.exp(-(now - at_store["timestamp"]).dt.days.clip(lower=0).to_numpy() / 60.0),
                                 index=at_store["name"].str.strip()).groupby(level=0).sum().sort_values(ascending=False)
                       if len(at_store) else names)
        out.append({
            "item": item,
            "product": str(store_names.index[0]),
            "otherProducts": [str(n) for n in names.index[:3] if n != store_names.index[0]],
            "usualQty": max(1, int(round(float(g["qty"].median())))),
            "store": apps.index[0] if len(apps) else None,
            "timesOrdered": int(len(g)),
            "lastOrderedDaysAgo": int((now - g["timestamp"].max()).days),
            "category": g["category"].iloc[-1],
            "restaurant": _mode(g["restaurant"]) if "restaurant" in g else None,
        })
    out.sort(key=lambda p: (-p["timesOrdered"], p["lastOrderedDaysAgo"]))
    return out[:limit]


def _mode(values: pd.Series) -> str | None:
    values = values.dropna()
    values = values[values.astype(str).str.strip() != ""]
    return str(values.mode().iloc[0]) if len(values) else None


def history_for_llm(profile: list[dict], limit: int = 25) -> str:
    """Compact lines for the intent prompt: what this user usually buys."""
    if not profile:
        return "none on record yet"
    return "\n".join(f"- {p['item']}: {p['product']}"
                     f"{' from restaurant ' + p['restaurant'] if p.get('restaurant') else ''} "
                     f"(usually x{p['usualQty']}, ordered {p['timesOrdered']}x, "
                     f"last {p['lastOrderedDaysAgo']} days ago{', ' + p['store'] if p['store'] else ''})"
                     for p in profile[:limit])


def _is_generic(name: str) -> bool:
    """'milk', 'curd', 'brown bread' -> generic (use their usual); 'amul taaza 1L', 'eggs 12 pcs' -> specific."""
    words = re.findall(r"[a-z]+", name.lower())
    return not re.search(r"\d", name) and len(words) <= _GENERIC_MAX_WORDS


def _similar(a: str, b: str) -> float:
    """How alike two dish names are, tolerant of spelling ("biryani"/"biriyani") and extra words ("bowl")."""
    a, b = dish_item(a), dish_item(b)
    ta, tb = a.split(), b.split()
    if not ta or not tb:
        return 0.0
    hits = sum(1 for w in ta if any(w == x or SequenceMatcher(None, w, x).ratio() >= 0.8 for x in tb))
    return hits / len(ta) * 0.7 + SequenceMatcher(None, a, b).ratio() * 0.3


def _match_dish(name: str, dishes: list[dict]) -> dict | None:
    """The past dish the user most likely means: every word they said appears in it (most-ordered wins ties)."""
    scored = [(round(_similar(name, p["product"]), 2), p["timesOrdered"], p) for p in dishes]
    scored = [s for s in scored if s[0] >= 0.8]
    return max(scored, key=lambda s: (s[0], s[1]))[2] if scored else None


def resolve_items(items: list[dict], profile: list[dict], store: str | None = None) -> tuple[list[dict], list[str]]:
    """Generic items become the user's usual product; on food apps, a dish they name becomes the exact dish they
    order (and its restaurant, passed along as a hint). Returns (items, notes about what was matched)."""
    by_item = {p["item"]: p for p in profile if p["category"] != RESTAURANT_FOOD}
    dishes = [p for p in profile if p["category"] == RESTAURANT_FOOD]
    food_store = canonical_app(store) in FOOD_APPS if store else False
    out, notes = [], []
    for it in items:
        qty_given = int(it.get("qty") or 1) != 1  # "2 milk" stays 2; plain "milk" -> their usual quantity
        if food_store:
            d = _match_dish(it["name"], dishes)
            if d:
                qty = it["qty"] if qty_given else d["usualQty"]
                hint = f"from restaurant {d['restaurant']}" if d.get("restaurant") else None
                out.append({**it, "name": d["product"], "qty": qty, "hint": hint, "fromHistory": True})
                notes.append(f"{it['name']} -> {d['product']}{' (' + d['restaurant'] + ')' if d.get('restaurant') else ''} "
                             f"x{qty} (ordered {d['timesOrdered']}x)")
            else:
                out.append(it)
            continue
        p = by_item.get(canonical_item(it["name"]))
        specific = p is not None and p["product"].strip().lower() not in (it["name"].strip().lower(), p["item"])
        if p and specific and _is_generic(it["name"]) and canonical_item(p["product"]) == p["item"]:
            qty = it["qty"] if qty_given else p["usualQty"]
            out.append({**it, "name": p["product"], "qty": qty, "fromHistory": True})
            notes.append(f"{it['name']} -> {p['product']} x{qty} (their usual, ordered {p['timesOrdered']}x)")
        else:
            out.append(it)
    return out, notes


def needs_sync(events: list[dict], store: str) -> bool:
    """Read the store's order history first if it was never read, or not in the last week."""
    app = canonical_app(store)
    cutoff = (pd.Timestamp.now() - pd.Timedelta(days=SYNC_EVERY_DAYS)).isoformat()
    return not any(e.get("action") == SYNC_MARKER and canonical_app(e.get("app")) == app
                   and str(e.get("timestamp") or "") >= cutoff for e in events)


def _order_date(value, today: date) -> str | None:
    """ISO date of an order, or None when the screen gave no usable date (never guessed: a made-up date would
    teach the model a purchase rhythm that didn't happen)."""
    text = str(value or "").strip().lower()
    if not text or text in ("null", "none", "unknown"):
        return None
    if text in ("today", "now"):
        return today.isoformat()
    if text == "yesterday":
        return (today - timedelta(days=1)).isoformat()
    m = re.match(r"(\d+)\s*(day|week|month)s?\s*ago", text)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return (today - timedelta(days=n * {"day": 1, "week": 7, "month": 30}[unit])).isoformat()
    try:
        ts = pd.Timestamp(text)
        if ts.year < 2000 or ts.date() > today:  # "28 Sep" parses into the wrong year: use the most recent past one
            ts = ts.replace(year=today.year)
            if ts.date() > today:
                ts = ts.replace(year=today.year - 1)
        return ts.date().isoformat()
    except (ValueError, TypeError):
        return None


def _name_key(name) -> str:
    """Same product read twice with different spacing/punctuation ("48 g" vs "48g") is one product."""
    return re.sub(r"[^a-z0-9]", "", str(name or "").lower())


def _id_key(order_id) -> str:
    return re.sub(r"[^A-Za-z0-9-]", "", str(order_id or "")) if order_id else ""


def _price(it: dict) -> float:
    try:
        return float(re.sub(r"[^\d.]", "", str(it.get("price") or "")) or 0)
    except ValueError:
        return 0.0


def imported_events(orders: list[dict], store: str, existing: list[dict], today: date) -> list[dict]:
    """Shopping events for orders read from a store app, minus ones already stored (same store, day and product)."""
    app = canonical_app(store)
    seen = {(canonical_app(e.get("app")), str(e.get("timestamp", ""))[:10], _name_key(e.get("name")))
            for e in existing if e.get("source") == "store_history"}
    seen_lines = {(canonical_app(e.get("app")), _id_key(e.get("orderId")), _name_key(e.get("name")))
                  for e in existing if e.get("source") == "store_history" and e.get("orderId")}
    out = []
    for o in orders or []:
        if not isinstance(o, dict):
            continue
        day = _order_date(o.get("date"), today)
        if day is None:
            continue  # no date on screen: skip rather than invent one
        real_id = _id_key(o.get("id"))
        order_id = (real_id or f"{day}-{uuid.uuid4().hex[:8]}")[:40]
        lines = [it for it in o.get("items") or [] if isinstance(it, dict) and str(it.get("name") or "").strip()]
        priced = any(_price(it) > 0 for it in lines)
        for it in lines:
            if priced and _price(it) == 0:
                continue  # free gift / sample that came with the order, not a purchase
            name = re.sub(r"\s+", " ", str(it["name"])).strip()[:120]
            key = (app, day, _name_key(name))
            if key in seen or (real_id and (app, real_id, _name_key(name)) in seen_lines):
                continue
            seen.add(key)
            seen_lines.add((app, real_id, _name_key(name)))
            try:
                qty = max(1.0, min(float(it.get("qty") or 1), 50))
            except (TypeError, ValueError):
                qty = 1.0
            price = _price(it)
            item = canonical_item(name)
            out.append({"timestamp": f"{day}T12:00:00", "action": "order", "name": name, "item": item,
                        "category": item_category(item) if item in CATALOG else "other", "app": app, "qty": qty,
                        "price": round(price / qty, 2) if price else 0.0, "source": "store_history",
                        "orderId": order_id})
    return out
