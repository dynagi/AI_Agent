"""Voice companion: one fast model call (no specialist-agent fan-out) that answers the way a caring nurse + assistant would,
and can ask the app to do a few well-defined things. The app executes the actions; nothing here touches the phone."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.llm_service import LLMServiceError, llm_service

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


@router.post("/converse", response_model=ConverseResponse)
async def converse(req: ConverseRequest) -> ConverseResponse:
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
    return ConverseResponse(say=say[:600], do=actions)
