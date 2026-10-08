"""The cart agent's two extra phases on the phone:

  * history - before ordering from a store for the first time (and weekly after), open the store app's own
    "Your orders" screens and read the user's past orders (products, sizes, quantities, dates) into their
    shopping history, so AURA knows their usual products and the next-purchase model has real data;
  * resolve - at the start of the cart phase, turn the command's generic items into the user's usual products
    from that history ("milk" -> "Amul Taaza Toned Milk 500 ml" x2), so the cart agent searches for those.
"""
from __future__ import annotations

import re

import pandas as pd
import structlog

from app.core.config import settings
from app.ml.shopping_predictor import now_ist, retrain_scheduler
from app.services import shopping_browser as sb
from app.services.llm_service import LLMServiceError, llm_service
from app.services.shopping_history import ShoppingHistoryError, shopping_history
from app.services.shopping_memory import (SYNC_MARKER, imported_events, product_profile, resolve_items)

logger = structlog.get_logger()
CAUGHT_UP_AFTER = 2
FULL_SYNC = 20  # historyLimit from "Learn from all my stores": always reads that deep (duplicates are skipped)  # already-stored orders in a row on a re-sync: everything older was read before
_NO_TOUCH = re.compile(r"\b(re-?order|repeat|order again|buy again|add|pay|help|cancel|rate|return|chat|support|share)\b", re.I)

_HISTORY_PROMPT = """You operate the {store} Android app on the user's phone to READ their past orders, so AURA learns
which products they buy. Today is {today}. Orders read so far: {read} (stop at {max}).
{app_hint}
You see the views on the current screen with ids, their text or content description, and "context" = the text of
the card/section around them.

Return JSON only:
{{"action": "click"|"scroll"|"back"|"wait"|"history_done", "elementId": id for click or null, "reason": short why,
  "orders": [{{"id": order number if shown or null, "date": "YYYY-MM-DD" (the order/delivery date shown; null if
              no date is visible for that order - never guess),
              "items": [{{"name": full product name with brand and size, "qty": integer,
                          "price": total paid for that line (qty x unit price), number or null}}]}}]}}

How to work:
- Get to the order history: open the account/profile (avatar / person icon / "Account" / "Profile"), then
  "Orders" / "Your orders" / "Order history". The profile button is often an icon without text, listed as
  "unlabeled icon at top-right" (or top-left, or a bottom tab): try those. Close popups or go "back" to the home
  screen first if needed.
- On the orders list, open the most recent order you haven't opened yet (see Recent actions), read it, then "back"
  to the list and open the next one. Scroll the list for older ones.
- "orders": only orders whose item names are visible on THIS screen (an order's detail page, or a list that shows
  item names). Convert "Yesterday", "28 Sep", "2 days ago" to YYYY-MM-DD. Leave "orders" empty otherwise. Don't
  repeat an order already read unless its items are shown again.
- history_done when {max} orders are read, there are no more orders, or the app shows no order history.
- READ ONLY: never click Reorder, Repeat, Order again, Add, Pay, Help, Cancel, Rate or Return. Never type.
  If the app needs login, use history_done."""


async def history_step(req: sb.StepRequest) -> sb.StepAction:
    limit = req.historyLimit
    if req.mode != "app":
        return await _finish_history(req, "order history is read in the store's app")
    if req.ordersRead >= limit:
        return await _finish_history(req, "read enough orders")
    if req.historyLimit < FULL_SYNC and req.ordersKnown >= CAUGHT_UP_AFTER and await _synced_before(req):
        # only on a quick re-sync before ordering: on a first read the same order shows up twice (list, then detail
        # page), and a full sync must reach older orders that an earlier, interrupted sync never got to
        return await _finish_history(req, "caught up with orders read before")
    if req.step > 12 + 5 * limit:
        return await _finish_history(req, "stopped reading")
    key = sb.store_key(req.store)
    system = _HISTORY_PROMPT.format(store=req.store, today=now_ist().date(), read=req.ordersRead, max=limit,
                                    app_hint=sb.STORES.get(key or "", {}).get("historyHint") or "")
    messages = [{"role": "system", "content": system}, {"role": "user", "content": sb._page_text(req)}]
    raw = None
    for model, timeout in ((settings.cart_agent_model, settings.shopping_agent_timeout_s + 10),
                           (None, settings.shopping_agent_timeout_s + 20)):
        try:
            raw = await llm_service.chat_json(messages, model=model, timeout=timeout, retries=1)
            break
        except LLMServiceError as exc:
            logger.warning("history_reader_llm_failed", model=model or "default", error=str(exc)[:200])
    if not isinstance(raw, dict):
        return sb.StepAction(action="wait", reason="reading orders (AI busy)", source="guard")

    saved, known = await _save_orders(req, raw.get("orders"))
    act = str(raw.get("action") or "wait")
    if act == "history_done":
        return await _finish_history(req, str(raw.get("reason") or "done"), saved)
    action = sb.StepAction(action=act if act in ("click", "scroll", "back", "wait") else "wait",
                           elementId=str(raw["elementId"]) if raw.get("elementId") is not None else None,
                           reason=str(raw.get("reason") or act)[:120], ordersSaved=saved, ordersKnown=known,
                           source="llm")
    sb._normalise_id(action, req)
    el = sb._element(req, action.elementId)
    if action.action == "click" and el is not None and _NO_TOUCH.search(f"{el.text} {el.label or ''}"):
        action = sb.StepAction(action="back" if saved else "wait", reason=f"read-only: not tapping '{el.text[:30]}'",
                               ordersSaved=saved, ordersKnown=known, source="guard")
    if action.action == "click" and el is not None:
        action.targetText = f"open: {(el.text or el.label or '')[:60]}"
    return sb.guard(action, req)


async def _synced_before(req: sb.StepRequest) -> bool:
    """This store's orders were read in an earlier sync (more than 30 minutes ago)."""
    if not req.userId or req.userId == "anonymous":
        return False
    try:
        events = await shopping_history.get_events(req.userId)
    except ShoppingHistoryError:
        return False
    name = sb.STORES.get(sb.store_key(req.store) or "", {}).get("name") or req.store
    before = (now_ist() - pd.Timedelta(minutes=30)).isoformat()
    return any(e.get("action") == SYNC_MARKER and e.get("app") == name and str(e.get("timestamp", "")) < before
               for e in events)


async def _save_orders(req: sb.StepRequest, orders) -> tuple[int, int]:
    """Stores newly read orders. Returns (new orders saved, orders that were already in the history)."""
    if not req.userId or req.userId == "anonymous" or not orders:
        return 0, 0
    orders = [o for o in orders if isinstance(o, dict) and o.get("items")]
    try:
        existing = await shopping_history.get_events(req.userId)
        events = imported_events(orders, req.store, existing, now_ist().date())
        if events:
            await shopping_history.add_events(req.userId, events)
        new = len({e["orderId"] for e in events})
        return new, max(0, len(orders) - new)
    except ShoppingHistoryError as exc:
        logger.warning("history_reader_save_failed", error=str(exc)[:200])
        return 0, 0


async def _finish_history(req: sb.StepRequest, reason: str, saved: int = 0) -> sb.StepAction:
    if req.userId and req.userId != "anonymous":
        try:
            await shopping_history.add_events(req.userId, [{
                "timestamp": now_ist().isoformat(), "action": SYNC_MARKER, "name": "order history",
                "app": sb.STORES.get(sb.store_key(req.store) or "", {}).get("name") or req.store,
                "qty": req.ordersRead + saved, "source": "store_history"}])
        except ShoppingHistoryError as exc:
            logger.warning("history_marker_failed", error=str(exc)[:200])
        if req.ordersRead + saved:
            retrain_scheduler.request(f"read {req.ordersRead + saved} past orders from {req.store}")
    n = req.ordersRead + saved
    return sb.StepAction(action="history_done", ordersSaved=saved, source="fast",
                         reason=f"read {n} past order{'s' if n != 1 else ''} ({reason})",
                         message=f"Read {n} past {req.store} orders.")


async def resolve_step(req: sb.StepRequest) -> sb.StepAction:
    """First cart step: swap generic items for the user's usual products (from history incl. what was just read)."""
    items = [{"name": it.name, "qty": it.qty, **({"hint": it.hint} if it.hint else {})} for it in req.items]
    notes: list[str] = []
    if req.userId and req.userId != "anonymous":
        try:
            profile = product_profile(await shopping_history.get_events(req.userId), store=req.store)
            items, notes = resolve_items(items, profile, store=req.store)
            notes += [f"{i['name']}: not in your past orders, picking a good match" for i in items
                      if not i.get("fromHistory")]
        except ShoppingHistoryError as exc:
            logger.warning("resolve_history_unavailable", error=str(exc)[:200])
    return sb.StepAction(action="set_items",
                         items=[{"name": i["name"], "qty": i["qty"], **({"hint": i["hint"]} if i.get("hint") else {})}
                                for i in items],
                         reason="; ".join(notes) if notes else "items as you said them",
                         source="fast")
