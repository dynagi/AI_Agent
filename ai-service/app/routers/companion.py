"""Voice companion: one fast model call (no specialist-agent fan-out) that answers the way a caring nurse + assistant would,
and can ask the app to do a few well-defined things. The app executes the actions; nothing here touches the phone."""
from __future__ import annotations

import re

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.llm_service import LLMServiceError, llm_service
import asyncio
import time

import structlog

from app.travel import assistant as flight_assistant

router = APIRouter(prefix="/ai", tags=["companion"])

# Screens the companion may take the user to.
NAV_PATHS = {"/dashboard", "/wellness", "/wellness?tab=Medicines", "/shopping", "/calendar", "/tasks", "/finance", "/travel", "/chat"}
ACTION_TYPES = {"open_app", "log_water", "log_meal", "took_medicine", "set_mood", "navigate", "order"}


class Turn(BaseModel):
    role: Literal["user", "aura"]
    text: str = Field(max_length=600)


class ConverseRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1500)
    # JSON snapshot of the user's day (water, meals, medicines, mood…), built by the app.
    context: str = Field(default="", max_length=6000)
    history: list[Turn] = Field(default_factory=list, max_length=8)
    # who is talking (set by the backend from the session): flight searches and preferences are per person
    userId: str | None = Field(default=None, max_length=100)
    # What AURA just asked, when the message is an answer to it ("Did you take your Metformin?").
    pending: str | None = Field(default=None, max_length=300)


class ConverseAction(BaseModel):
    type: str
    args: dict[str, Any] = Field(default_factory=dict)


class ConverseResponse(BaseModel):
    say: str
    do: list[ConverseAction] = Field(default_factory=list)


SYSTEM_PROMPT = """You are AURA — the user's personal nurse, assistant, helper and listener — speaking out loud through their phone.

How to talk:
- Warm, calm, natural spoken language. One to two short sentences (about 30 words). No lists, markdown, emoji or stage directions.
- Ask at most ONE question at a time, and only when it helps. Listen first; don't lecture.
- Reply in the language the user speaks (English, Hindi or Hinglish).
- You care about their day: water, meals, medicine, rest, movement, mood. Notice how they sound and respond to it.
- If the context has "habits" (which apps they use and when, topics they like), let it quietly shape suggestions. Never recite it, and never say you are watching what they do.

Safety:
- You are not a doctor. Don't diagnose or change medicine doses. For symptoms give simple self-care and suggest seeing a doctor when it matters.
- Chest pain, trouble breathing, stroke signs, heavy bleeding, fainting, or thoughts of self-harm: say plainly to call the local emergency number now (112 in India) and to reach someone nearby; be kind and stay brief.

What you can ask the app to do, in "do" (only when the user clearly asked or reported it):
- {"type":"open_app","args":{"name":"WhatsApp"}}  open an installed app by its name
- {"type":"log_water","args":{"glasses":2}}  they drank water
- {"type":"log_meal","args":{"name":"Lunch","dish":"dal rice"}}  they ate (name: Breakfast, Lunch, Snack or Dinner)
- {"type":"took_medicine","args":{"name":"Metformin"}}  they took a medicine (omit name if unspecified)
- {"type":"set_mood","args":{"mood":"Low"}}  one of Great, Good, Okay, Low, Stressed
- {"type":"navigate","args":{"path":"/wellness?tab=Medicines"}}  open a screen
- {"type":"order","args":{"text":"order toned milk"}}  they want to order groceries, food or medicine
You cannot read their messages or contacts, make calls or payments by yourself. Never say you did something unless you put it in "do".

Reply with ONLY this JSON: {"say": "<what you speak>", "do": [<0-3 actions>]}"""


# The phone can send the same spoken sentence more than once (its voice service asks the server directly while the
# app's web view answers too). A repeat must get the same reply, not be acted on again (seen: the second copy of
# "direct, evening, cheapest" was taken as choosing the flight, which ended the flight conversation).
REPEAT_WINDOW_S = 20
_recent: dict[tuple[str, str], tuple[float, "ConverseResponse"]] = {}
_working: dict[tuple[str, str], asyncio.Future] = {}


@router.post("/converse", response_model=ConverseResponse)
async def converse(req: ConverseRequest) -> ConverseResponse:
    key = (req.userId or "anonymous", re.sub(r"[^\w\s]", "", req.message).strip().lower())
    if key[0] == "anonymous":
        return await _converse(req)
    now = time.time()
    hit = _recent.get(key)
    if hit and now - hit[0] < REPEAT_WINDOW_S:
        return hit[1]
    if key in _working:                       # the first copy is still being answered (a flight search takes seconds)
        return await asyncio.shield(_working[key])
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    _working[key] = future
    try:
        reply = await _converse(req)
        future.set_result(reply)
    except Exception as exc:
        future.set_exception(exc)
        future.exception()                    # retrieved: no "never retrieved" warning when nobody else waited
        raise
    finally:
        _working.pop(key, None)
    for k in [k for k, (t, _) in _recent.items() if now - t > REPEAT_WINDOW_S]:
        _recent.pop(k, None)
    _recent[key] = (time.time(), reply)
    return reply


async def _converse(req: ConverseRequest) -> ConverseResponse:
    # flights have their own assistant (live search, prices per website, preferences); it answers when the message
    # is about a flight or replies to one of its questions, and stays out of everything else
    had_session = flight_assistant._session(req.userId or "anonymous") is not None
    flight_reply = await flight_assistant.handle(req.message, req.userId or "anonymous")
    # which path answered (no message text): explains a flight conversation that fell through to the chat
    structlog.get_logger().info("converse_route", route="flight" if flight_reply is not None else "chat",
                                had_flight_session=had_session, signed_in=bool(req.userId), history=len(req.history))
    if flight_reply is not None:
        return ConverseResponse(say=flight_reply[:1200], do=[])
    messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if req.context:
        messages.append({"role": "system", "content": f"The user's day so far (JSON): {req.context}"})
    for t in req.history[-6:]:
        messages.append({"role": "user" if t.role == "user" else "assistant", "content": t.text})
    user = req.message if not req.pending else f"(You had just asked: \"{req.pending}\")\nUser: {req.message}"
    messages.append({"role": "user", "content": user})

    try:
        data = await llm_service.chat_json(messages, max_tokens=260)
    except LLMServiceError as exc:
        # The model sometimes answers in plain text instead of JSON — speak that rather than failing.
        raw = str(exc)
        marker = "Model did not return valid JSON: "
        if marker in raw:
            text = raw.split(marker, 1)[1].strip()
            if text:
                return ConverseResponse(say=text[:400])
        raise HTTPException(status_code=503, detail=raw) from exc

    say = str(data.get("say", "")).strip()
    if not say:
        raise HTTPException(status_code=502, detail="Empty reply from model")
    actions: list[ConverseAction] = []
    for a in (data.get("do") or [])[:3]:
        if not isinstance(a, dict) or a.get("type") not in ACTION_TYPES:
            continue
        args = a.get("args") if isinstance(a.get("args"), dict) else {}
        if a["type"] == "navigate" and args.get("path") not in NAV_PATHS:
            continue
        actions.append(ConverseAction(type=a["type"], args=args))
    return ConverseResponse(say=honest(say, actions)[:600], do=actions)


# "I've added it to your cart", "your order is placed", "message sent": things only an action can make true
_CLAIM = re.compile(
    r"\b(?:i(?:'ve| have)?|i just|it(?:'s| is| has been)?|your \w+(?: \w+)? (?:is|has been|are|was))\s+(?:already\s+|now\s+|just\s+)?"
    r"(?:added|ordered|placed|purchased|bought|booked|paid|sent|messaged|called|cancelled|canceled|scheduled|reserved)\b",
    re.I)
# "I'll remind you at 6", "I've set an alarm": promises nothing here can keep
_PROMISE = re.compile(
    r"\b(?:i(?:'ll| will| can)? (?:remind you|set (?:a |an |the |that )?(?:reminder|alarm|timer)|wake you|alert you|notify you)"
    r"|(?:reminder|alarm|timer) (?:is |has been )?set\b|i(?:'ve| have) set (?:a |an |the |that )?(?:reminder|alarm|timer))", re.I)
# actions that really do something in the app, by the kind of claim they back up
_DOES = {"order", "log_water", "log_meal", "took_medicine", "set_mood", "open_app", "navigate"}


def honest(say: str, actions: list[ConverseAction]) -> str:
    """The model must not say it did something it has no way of doing in this reply. When its sentence claims a
    completed action (added to a cart, ordered, sent, paid, called...) and no action that could do it is attached,
    the claim is replaced: this assistant never reports something that didn't happen."""
    if _PROMISE.search(say):
        # there is no reminder, alarm or timer behind this assistant yet: promising one would simply not happen
        return ("I can't set reminders or alarms yet, so I won't promise that. "
                "Your phone's clock app can do it, and I can open it for you.")
    if not _CLAIM.search(say):
        return say
    if any(a.type in _DOES for a in actions):
        return say
    return ("I haven't actually done that. Tell me exactly what you want, for example "
            "\"order pizza from Zomato\", and I'll start on it.")
