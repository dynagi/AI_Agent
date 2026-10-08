"""Turns order invoices (PDF text) into shopping events, entirely locally: no LLM, nothing leaves the machine.

Only the order facts are kept (store, restaurant, date, items, quantities, prices). Customer name, address, GST
numbers and the rest of the invoice are never read into the result.

Supported layouts (more can be added as parse_* functions):
  * Zomato "Tax Invoice"                      (Invoice_<order id>.pdf)
  * Zomato "Food Order: Summary and Receipt"  (Order_ID_<order id>.pdf)
"""
from __future__ import annotations

import re
from datetime import datetime

RESTAURANT_FOOD = "restaurant_food"
_NUM = r"\d+(?:\.\d+)?"
# gross, discount, net, then tax columns, ending with the line total
_TAX_ROW = re.compile(rf"({_NUM}) ({_NUM}) ({_NUM}) {_NUM}% {_NUM} {_NUM}% {_NUM} ({_NUM})\s*$")
_RECEIPT_ROW = re.compile(r"^(.+?) (\d{1,2}) ₹?\s*([\d,]+(?:\.\d+)?) ₹?\s*([\d,]+(?:\.\d+)?)$")
_NOT_ITEMS = re.compile(r"membership|round off|^₹|^taxes\b|delivery|packaging|platform fee|coupon|^total\b", re.I)


def parse_invoice(text: str) -> dict | None:
    """One order from an invoice's text, or None if the layout isn't recognised.
    {store, orderId, timestamp (ISO), restaurant, category, items: [{name, qty, price (unit, paid), gross}]}"""
    head = text[:200]
    if "Zomato Food Order" in head:
        return _zomato_receipt(text)
    if "Tax Invoice" in head and "ZOMATO" in text.upper():
        return _zomato_tax_invoice(text)
    return None


def _field(text: str, label: str) -> str | None:
    m = re.search(rf"{label}\s*:?\s*(.+)", text)
    return m.group(1).strip() if m else None


def _clean_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip(" .-")


def _zomato_tax_invoice(text: str) -> dict | None:
    order = re.search(r"Order ID (\d+) dated (\d{4}-\d{2}-\d{2})", text)
    start, end = text.find("Particulars Gross value"), text.find("Item(s) Total")
    if not order or start < 0 or end < start:
        return None
    items: list[dict] = []
    for line in text[start:end].split("\n")[1:]:
        line = line.strip()
        if not line:
            continue
        begins = re.match(r"^(\d+) x (.*)$", line)
        row = _TAX_ROW.search(line)
        if begins:
            name = begins.group(2)
            if row:
                name = name[: name.rfind(row.group(0).strip())] if row.group(0).strip() in name else name
            items.append({"name": name.strip(), "qty": int(begins.group(1)), "gross": None, "net": None})
        elif items and not row:
            items[-1]["name"] += " " + line  # dish name wrapped onto the next line
        if row and items:
            name_part = line[: row.start()].strip()
            if not begins and name_part:
                items[-1]["name"] += " " + name_part
            items[-1]["gross"], items[-1]["net"] = float(row.group(1)), float(row.group(3))
    return _order("Zomato", order.group(1), f"{order.group(2)}T13:00:00", _field(text, "Restaurant Name"), [
        {"name": _clean_name(i["name"]), "qty": i["qty"], "gross": i["gross"],
         "price": round((i["net"] if i["net"] is not None else i["gross"] or 0) / i["qty"], 2)}
        for i in items if i["gross"] is not None])


def _zomato_receipt(text: str) -> dict | None:
    order_id, when = _field(text, "Order ID"), _field(text, "Order Time")
    start, end = text.find("Item Quantity Unit Price"), text.find("Taxes")
    if not order_id or not when or start < 0 or end < start:
        return None
    try:
        ts = datetime.strptime(when, "%d %B %Y, %I:%M %p").isoformat()
    except ValueError:
        return None
    items = []
    for line in text[start:end].split("\n")[1:]:
        line = line.strip()
        m = _RECEIPT_ROW.match(line)
        if not m or _NOT_ITEMS.search(line):
            continue
        qty, total = int(m.group(2)), float(m.group(4).replace(",", ""))
        items.append({"name": _clean_name(m.group(1)), "qty": qty, "gross": total, "price": round(total / qty, 2)})
    return _order("Zomato", order_id, ts, _field(text, "Restaurant Name"), items)


def _order(store: str, order_id: str, timestamp: str, restaurant: str | None, items: list[dict]) -> dict | None:
    if not items:
        return None
    return {"store": store, "orderId": order_id, "timestamp": timestamp, "restaurant": restaurant,
            "category": RESTAURANT_FOOD, "items": items}


def order_events(order: dict, existing: list[dict]) -> list[dict]:
    """Shopping events for a parsed order, skipping lines already imported (same order id and item)."""
    seen = {(str(e.get("orderId")), str(e.get("name", "")).lower()) for e in existing if e.get("source") == "invoice"}
    out = []
    for it in order["items"]:
        if (order["orderId"], it["name"].lower()) in seen:
            continue
        out.append({"timestamp": order["timestamp"], "action": "order", "name": it["name"], "qty": it["qty"],
                    "price": it["price"], "app": order["store"], "category": order["category"],
                    "restaurant": order["restaurant"], "source": "invoice", "orderId": order["orderId"]})
    return out
