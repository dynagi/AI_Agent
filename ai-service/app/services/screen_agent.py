"""Screen agent: the phone reads what is on screen and AURA decides the next single action for a spoken goal
("tap the second video", "scroll down", "like this post"), plus visual product search ("find this").

The phone does the acting; nothing here touches it. Every step is validated before it is returned: it must name
an element that is really on screen, never touches payment or password controls, and anything that sends, posts,
deletes or buys is flagged `risky` so the phone asks the user first.
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.core.config import settings
from app.services.llm_service import LLMServiceError, llm_service
from app.services.shopping_service import ShoppingResult, ShoppingServiceError, search_products

ACTIONS = {"click", "type", "scroll", "back", "home", "wait", "done", "need_user"}
MAX_ELEMENTS = 180

# Payment and credential controls are never touched, whatever the user said.
FORBIDDEN = re.compile(
    r"\b(pay|payment|payments|checkout|check\s*out|place\s*order|confirm\s*order|complete\s*order|buy\s*now|"
    r"proceed\s*to\s*(pay|buy|checkout)|slide\s*to\s*pay|swipe\s*to\s*pay|upi|cash\s*on\s*delivery|cvv|otp|"
    r"password|passcode)\b", re.I)
# Always confirmed with the user before pressing: these can't be taken back, or speak for the user.
ALWAYS_CONFIRM = re.compile(
    r"\b(send|post|publish|delete|remove|transfer|submit|confirm|order|buy|log\s*out|sign\s*out|uninstall|block|report)\b", re.I)
# Confirmed unless the user's own words asked for exactly this ("follow him", "share it").
CONFIRM_UNLESS_ASKED = ("share", "follow", "unfollow", "subscribe", "call")

SYSTEM_PROMPT = """You operate an Android phone for the user by reading the screen and choosing ONE next action toward their goal.

You get: the goal (what the user said), the app, the screen's tappable/editable elements as JSON (id, text, label, role, editable, scrollable, context = text of the card around it), the visible text, and the actions already done.

Reply with ONLY this JSON:
{"action": "click|type|scroll|back|home|wait|done|need_user", "elementId": "<id from the list>", "text": "<text to type>", "submit": false, "message": "<what to say to the user>", "reason": "<short why>"}

Rules:
- click: elementId of the control. Choose by meaning (text, label, role, context). Never guess an id that is not in the list.
- type: elementId of an editable field plus text; submit=true to press enter/search afterwards.
- scroll: to reveal more (elementId of a scrollable list is optional).
- back / home: system navigation. wait: the screen is still loading.
- done: the goal is reached; message says, in one short spoken sentence, what you did.
- need_user: you can't continue (login, captcha, the thing isn't there, unclear goal); message says why in one short sentence.
- Never press payment, checkout, OTP or password controls, and never type into a password field. If the goal needs them, say need_user.
- Do only what the goal asks. Don't open other apps, change settings, or buy, send or delete anything the goal didn't ask for.
- If the goal is already reached on this screen, answer done. If the same action keeps not working, answer need_user.
- Keep every message under 25 words, plain spoken English."""


class ScreenStepError(Exception):
    pass


def _clip(s: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()[:n]


def risk_for(label: str, goal: str) -> bool:
    """Whether pressing a control called `label` must be confirmed with the user first."""
    if ALWAYS_CONFIRM.search(label):
        return True
    low_goal = goal.lower()
    for verb in CONFIRM_UNLESS_ASKED:
        if re.search(rf"\b{verb}\b", label, re.I) and not re.search(rf"\b{verb}", low_goal):
            return True
    return False


def _element_text(el: dict[str, Any]) -> str:
    return " ".join(str(el.get(k) or "") for k in ("text", "label", "role"))


def _build_messages(goal: str, app: str, elements: list[dict[str, Any]], page_text: str,
                    history: list[dict[str, Any]], screenshot: str | None) -> list[dict[str, Any]]:
    slim = [{k: v for k, v in e.items() if k in ("id", "tag", "text", "label", "role", "editable", "scrollable", "disabled", "type", "context")}
            for e in elements[:MAX_ELEMENTS]]
    body = (f"Goal: {goal}\nApp: {app}\nActions so far: {json.dumps(history[-8:], ensure_ascii=False)}\n"
            f"Visible text: {_clip(page_text, 1500)}\nElements: {json.dumps(slim, ensure_ascii=False)}")
    user: Any = body
    if screenshot:
        user = [{"type": "text", "text": body + "\n(A screenshot of the screen is attached; use it when the elements list is not enough.)"},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{screenshot}"}}]
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def validate_step(raw: dict[str, Any], elements: list[dict[str, Any]], goal: str) -> dict[str, Any]:
    """Turns whatever the model said into one safe action the phone can perform."""
    action = str(raw.get("action", "")).strip().lower()
    message = _clip(raw.get("message"), 200)
    reason = _clip(raw.get("reason"), 160)
    by_id = {str(e.get("id")): e for e in elements}
    if action not in ACTIONS:
        return {"action": "need_user", "message": "I wasn't sure what to do next on this screen.", "reason": reason}

    if action in ("click", "type"):
        el = by_id.get(str(raw.get("elementId", "")))
        if el is None:
            return {"action": "need_user", "message": "I couldn't find that on the screen.", "reason": reason}
        label = _element_text(el)
        # the card around the control counts too: an unlabeled "ADD" next to "Place order" is not safe to press
        if action == "click" and (FORBIDDEN.search(label) or FORBIDDEN.search(str(el.get("context") or ""))
                                  and len(label.strip()) < 30):
            return {"action": "need_user", "message": "That looks like a payment or security step, so I'll leave it to you.",
                    "reason": reason}
        if action == "type":
            if el.get("type") == "password" or FORBIDDEN.search(label):
                return {"action": "need_user", "message": "I don't type passwords or codes. Please do that part.", "reason": reason}
            if not el.get("editable"):
                return {"action": "need_user", "message": "I couldn't find a place to type.", "reason": reason}
            return {"action": "type", "elementId": str(el["id"]), "text": _clip(raw.get("text"), 300),
                    "submit": bool(raw.get("submit")), "reason": reason, "risky": False}
        # an unlabeled icon is judged by the card around it
        shown = _clip(label, 60) or _clip(el.get("context"), 60)
        return {"action": "click", "elementId": str(el["id"]), "reason": reason, "risky": risk_for(shown, goal), "target": shown}

    if action == "scroll":
        eid = str(raw.get("elementId", ""))
        return {"action": "scroll", "elementId": eid if eid in by_id else None, "reason": reason}
    if action in ("done", "need_user"):
        return {"action": action, "message": message or ("Done." if action == "done" else "I need your help to continue."), "reason": reason}
    return {"action": action, "reason": reason}


def _stuck(history: list[dict[str, Any]]) -> bool:
    last = [(h.get("action"), h.get("target")) for h in history[-3:]]
    return len(last) == 3 and len(set(last)) == 1 and last[0][0] not in ("scroll", "wait")


async def next_step(goal: str, app: str, elements: list[dict[str, Any]], page_text: str,
                    history: list[dict[str, Any]], step: int, screenshot: str | None = None) -> dict[str, Any]:
    if step >= 14:
        return {"action": "need_user", "message": "That's taking too many steps, so I've stopped. Tell me what to do next.", "reason": "step limit"}
    if _stuck(history):
        return {"action": "need_user", "message": "I seem to be stuck on this screen, so I've stopped.", "reason": "repeated action"}
    messages = _build_messages(goal, app, elements, page_text, history, screenshot)
    try:
        if screenshot:
            raw = await llm_service.vision_json(messages, max_tokens=300, timeout=settings.screen_agent_timeout_s)
        else:
            raw = await llm_service.chat_json(messages, max_tokens=300, timeout=settings.screen_agent_timeout_s, retries=2)
    except LLMServiceError as exc:
        raise ScreenStepError(str(exc)) from exc
    return validate_step(raw, elements, goal)


# ---------------------------------------------------------------------------------------------------------------
# Visual product search
# ---------------------------------------------------------------------------------------------------------------
VISION_SYSTEM = """You look at a phone screenshot and find the product the user is looking at, so it can be searched in shops.

Identify purchasable products visible in the screenshot (clothes, shoes, gadgets, furniture, food, beauty items, books...). If the user said which one ("the red shoes"), focus on that. Ignore the app's own interface, ads for services, and anything private (messages, names, numbers). Never identify or describe people; only the items they wear or hold.

Reply with ONLY this JSON:
{"summary": "<one short spoken sentence: what you see, e.g. 'White running shoes with a blue sole'>",
 "products": [{"name": "<specific product name, with brand/model only if clearly readable>", "brand": "<brand or null>", "category": "<category>",
               "query": "<best shopping search query to find this exact item, 3-8 words, with colour/type/brand>", "confidence": 0.0}]}

At most 3 products, best match first. confidence is 0 to 1: how sure you are this is what the user means. If there is no product in the image, return an empty products list and say so in summary."""


def _valid_image(b64: str) -> bool:
    # JPEG ("/9j/") or PNG ("iVBOR") only
    return len(b64) > 100 and (b64.startswith("/9j/") or b64.startswith("iVBOR"))


async def visual_search(image_b64: str, hint: str = "", max_results: int = 6) -> dict[str, Any]:
    if not _valid_image(image_b64):
        raise ScreenStepError("The screenshot wasn't a usable image.")
    mime = "image/png" if image_b64.startswith("iVBOR") else "image/jpeg"
    text = f"The user said: \"{_clip(hint, 200)}\"" if hint else "The user asked what product this is."
    messages = [{"role": "system", "content": VISION_SYSTEM},
                {"role": "user", "content": [{"type": "text", "text": text},
                                             {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}}]}]
    try:
        data = await llm_service.vision_json(messages, max_tokens=500, timeout=settings.screen_agent_timeout_s)
    except LLMServiceError as exc:
        raise ScreenStepError(str(exc)) from exc

    products: list[dict[str, Any]] = []
    for p in (data.get("products") or [])[:3]:
        if not isinstance(p, dict) or not str(p.get("query") or "").strip():
            continue
        try:
            conf = max(0.0, min(1.0, float(p.get("confidence", 0.5))))
        except (TypeError, ValueError):
            conf = 0.5
        products.append({"name": _clip(p.get("name") or p.get("query"), 100), "brand": _clip(p.get("brand"), 40) or None,
                         "category": _clip(p.get("category"), 40) or None, "query": _clip(p.get("query"), 100), "confidence": conf})
    products.sort(key=lambda p: -p["confidence"])

    results: list[ShoppingResult] = []
    note = None
    if products:
        try:
            results = await search_products(products[0]["query"], max_results=max_results)
        except ShoppingServiceError as exc:
            note = f"Price comparison is unavailable ({exc})"
    return {"summary": _clip(data.get("summary"), 200), "products": products,
            "query": products[0]["query"] if products else None,
            "results": [r.model_dump() for r in results], "note": note}
