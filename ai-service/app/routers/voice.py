from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from app.services.voice_service import VoiceServiceError, voice_service

router = APIRouter(prefix="/ai/voice", tags=["voice"])


class SpeakRequest(BaseModel):
    text: str
    voiceId: str | None = None


@router.post("/speak")
async def speak(req: SpeakRequest):
    try:
        audio = await voice_service.text_to_speech(req.text, req.voiceId)
    except VoiceServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(content=audio, media_type=voice_service.content_type)
