"""VoiceService abstraction. Gemini TTS is the default provider; ElevenLabs
remains available behind the same interface, and Vapi can be added the
same way later."""
from __future__ import annotations

import base64
import struct

import httpx

from app.core.config import settings


class VoiceServiceError(Exception):
    pass


class VoiceProvider:
    content_type: str = "audio/mpeg"

    async def text_to_speech(self, text: str, voice_id: str | None = None) -> bytes:
        raise NotImplementedError


def _pcm_to_wav(pcm_data: bytes, *, sample_rate: int = 24000, channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """Gemini TTS returns raw 16-bit PCM with no container — wrap it in a
    minimal WAV header so any audio player/browser can decode it."""
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm_data)

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM format
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm_data


class GeminiProvider(VoiceProvider):
    """Google Gemini TTS (Generative Language API)."""

    content_type = "audio/wav"

    async def text_to_speech(self, text: str, voice_id: str | None = None) -> bytes:
        if not settings.gemini_api_key:
            raise VoiceServiceError("GEMINI_API_KEY is not configured.")

        voice_name = voice_id or settings.gemini_voice_name
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{settings.gemini_tts_model}:generateContent"
        )

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                url,
                headers={
                    "x-goog-api-key": settings.gemini_api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "contents": [{"parts": [{"text": text}]}],
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": {
                            "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice_name}}
                        },
                    },
                },
            )

        if resp.status_code >= 400:
            raise VoiceServiceError(f"Gemini TTS failed ({resp.status_code}): {resp.text}")

        data = resp.json()
        try:
            inline = data["candidates"][0]["content"]["parts"][0]["inlineData"]
            pcm_bytes = base64.b64decode(inline["data"])
        except (KeyError, IndexError) as exc:
            raise VoiceServiceError(f"Unexpected Gemini TTS response shape: {data}") from exc

        return _pcm_to_wav(pcm_bytes)


class ElevenLabsProvider(VoiceProvider):
    async def text_to_speech(self, text: str, voice_id: str | None = None) -> bytes:
        if not settings.elevenlabs_api_key:
            raise VoiceServiceError("ELEVENLABS_API_KEY is not configured.")

        vid = voice_id or settings.elevenlabs_voice_id
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{vid}",
                headers={
                    "xi-api-key": settings.elevenlabs_api_key,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                json={
                    "text": text,
                    "model_id": "eleven_multilingual_v2",
                    "voice_settings": {"stability": 0.4, "similarity_boost": 0.8},
                },
            )
        if resp.status_code >= 400:
            raise VoiceServiceError(f"ElevenLabs TTS failed ({resp.status_code}): {resp.text}")
        return resp.content


_PROVIDERS: dict[str, type[VoiceProvider]] = {
    "gemini": GeminiProvider,
    "elevenlabs": ElevenLabsProvider,
}


def _build_provider() -> VoiceProvider:
    provider_cls = _PROVIDERS.get(settings.voice_provider, GeminiProvider)
    return provider_cls()


voice_service: VoiceProvider = _build_provider()
