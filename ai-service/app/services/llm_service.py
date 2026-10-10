"""LLMService abstraction. All model calls go through this module so the
provider (NVIDIA NIM by default; Grok and OpenRouter as alternatives) can be swapped
without touching callers."""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()


class LLMServiceError(Exception):
    pass


class LLMProvider:
    async def chat(self, messages: list[dict[str, str]], *, json_mode: bool = False, max_tokens: int | None = None,
                   model: str | None = None, timeout: float = 60, retries: int = 3) -> str:
        raise NotImplementedError


def _extract_json_object(text: str) -> str:
    """Strips markdown code fences some providers wrap JSON in, and falls
    back to the first {...} block if the model added surrounding prose."""
    stripped = text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", stripped, re.DOTALL)
    if fence_match:
        return fence_match.group(1)
    brace_match = re.search(r"\{.*\}", stripped, re.DOTALL)
    if brace_match:
        return brace_match.group(0)
    return stripped


class _OpenAICompatibleProvider(LLMProvider):
    """Base for any provider exposing an OpenAI-style /chat/completions
    endpoint (Grok, NVIDIA NIM, and most other hosted LLM gateways)."""

    api_key: str
    base_url: str
    model: str
    label: str
    supports_json_mode: bool = True

    async def chat(self, messages: list[dict[str, str]], *, json_mode: bool = False, max_tokens: int | None = None,
                   model: str | None = None, timeout: float = 60, retries: int = 3) -> str:
        if not self.api_key:
            raise LLMServiceError(f"{self.label} API key is not configured.")

        payload: dict[str, Any] = {
            "model": model or self.model,
            "messages": messages,
            "temperature": 0.4,
        }
        if max_tokens:
            payload["max_tokens"] = max_tokens
        if json_mode and self.supports_json_mode:
            payload["response_format"] = {"type": "json_object"}

        # Hosted models occasionally return a transient 5xx or drop the connection; retry those a couple of times.
        resp: httpx.Response | None = None
        last_error = ""
        for attempt in range(retries):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(
                        f"{self.base_url}/chat/completions",
                        headers={
                            "Authorization": f"Bearer {self.api_key}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                    )
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                resp = None
            else:
                if resp.status_code < 500 and resp.status_code != 429:
                    break
                last_error = f"{resp.status_code}: {resp.text[:200]}"
            if attempt < retries - 1:
                await asyncio.sleep(1.5 * (attempt + 1))
        if resp is None or resp.status_code >= 500 or resp.status_code == 429:
            raise LLMServiceError(f"{self.label} is temporarily unavailable ({last_error})")
        if resp.status_code >= 400:
            raise LLMServiceError(f"{self.label} request failed ({resp.status_code}): {resp.text[:300]}")

        data = resp.json()
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as exc:
            raise LLMServiceError(f"Unexpected {self.label} response shape: {data}") from exc


class GrokProvider(_OpenAICompatibleProvider):
    label = "Grok"

    def __init__(self) -> None:
        self.api_key = settings.grok_api_key
        self.base_url = settings.grok_base_url
        self.model = settings.grok_model


class NvidiaProvider(_OpenAICompatibleProvider):
    """NVIDIA NIM (integrate.api.nvidia.com) — OpenAI-compatible endpoint.
    Not every hosted model supports response_format=json_object, so JSON
    output is enforced via prompting + lenient extraction instead."""

    label = "NVIDIA NIM"
    supports_json_mode = False

    def __init__(self) -> None:
        self.api_key = settings.nvidia_api_key
        self.base_url = settings.nvidia_base_url
        self.model = settings.nvidia_model


class OpenRouterProvider(_OpenAICompatibleProvider):
    """OpenRouter (openrouter.ai) — one OpenAI-compatible endpoint in front of many hosted models."""

    label = "OpenRouter"
    supports_json_mode = False

    def __init__(self) -> None:
        self.api_key = settings.openrouter_api_key
        self.base_url = settings.openrouter_base_url
        self.model = settings.openrouter_model


_PROVIDERS: dict[str, type[_OpenAICompatibleProvider]] = {
    "nvidia": NvidiaProvider,
    "grok": GrokProvider,
    "openrouter": OpenRouterProvider,
}


def _build_provider() -> LLMProvider:
    provider_cls = _PROVIDERS.get(settings.llm_provider, NvidiaProvider)
    return provider_cls()


# after the main provider refuses for an account reason, how long the stand-in answers before the main one is tried again
SPARE_FOR_S = 600
_primary_refused_until = 0.0


def account_refused(exc: Exception) -> bool:
    """The provider turned the request away because of the account (out of credit, key rejected), not a glitch."""
    text = str(exc).lower()
    return any(m in text for m in ("(402)", "(401)", "(403)", "more credits", "insufficient", "quota", "invalid api key"))


class LLMService:
    def __init__(self, provider: LLMProvider):
        self._provider = provider

    async def chat(self, messages: list[dict[str, str]], *, max_tokens: int | None = None, model: str | None = None,
                   timeout: float = 60, retries: int = 3) -> str:
        return await self._with_fallback(messages, max_tokens=max_tokens, model=model, timeout=timeout,
                                         retries=retries)

    async def _primary(self, messages: list[dict[str, str]], *, json_mode: bool = False,
                       max_tokens: int | None = None, model: str | None = None, timeout: float = 60,
                       retries: int = 3) -> str:
        """The requested (or main) model first; if it fails (hosted models get retired or overloaded without
        notice), each backup model in turn. Raises the last error when none answers."""
        # the backup ids are NVIDIA models; other providers (Grok, OpenRouter) just use their own model
        backups = ([m.strip() for m in settings.llm_fallback_models.split(",") if m.strip()]
                   if settings.llm_provider == "nvidia" else [])
        primary = model or getattr(self._provider, "model", None)
        max_tokens = max_tokens or settings.llm_default_max_tokens or None
        last: LLMServiceError | None = None
        for i, m in enumerate([model] + [b for b in backups if b != primary]):
            try:
                # backups get one attempt each: the primary already used the retries
                return await self._provider.chat(messages, json_mode=json_mode, max_tokens=max_tokens, model=m,
                                                 timeout=timeout, retries=retries if i == 0 else 1)
            except LLMServiceError as exc:
                last = exc
        raise last or LLMServiceError("No LLM model is configured.")

    async def _with_fallback(self, messages: list[dict[str, str]], *, json_mode: bool = False,
                             max_tokens: int | None = None, model: str | None = None, timeout: float = 60,
                             retries: int = 3) -> str:
        """The configured provider first. If it turns the request away for an account reason (out of credit, key
        rejected) and a free NVIDIA key is configured, NVIDIA answers instead, and keeps answering for a while so
        every request doesn't first knock on a door that is closed."""
        global _primary_refused_until
        spare = self._spare()
        if spare is None or time.time() >= _primary_refused_until:
            try:
                return await self._primary(messages, json_mode=json_mode, max_tokens=max_tokens, model=model,
                                           timeout=timeout, retries=retries)
            except LLMServiceError as exc:
                if spare is None or not account_refused(exc):
                    raise
                _primary_refused_until = time.time() + SPARE_FOR_S
                logger.warning("llm.primary_refused_using_spare", provider=settings.llm_provider, error=str(exc)[:160])
        last: LLMServiceError | None = None
        models = [settings.nvidia_model] + [m.strip() for m in settings.llm_fallback_models.split(",") if m.strip()]
        for m in dict.fromkeys(models):   # the caller's model id belongs to the primary provider: not used here
            try:
                return await spare.chat(messages, json_mode=json_mode,
                                        max_tokens=max_tokens or settings.llm_default_max_tokens or None, model=m,
                                        timeout=timeout, retries=1)
            except LLMServiceError as exc:
                last = exc
        raise last or LLMServiceError("No LLM model is configured.")

    def _spare(self) -> "NvidiaProvider | None":
        """The free stand-in provider, when one is configured and isn't already the main one."""
        if settings.llm_provider == "nvidia" or not settings.nvidia_api_key:
            return None
        return NvidiaProvider()

    async def chat_json(self, messages: list[dict[str, str]], *, max_tokens: int | None = None, model: str | None = None,
                        timeout: float = 60, retries: int = 3) -> dict[str, Any]:
        """model/timeout/retries override the provider defaults for latency-sensitive callers (the cart agent)."""
        json_instruction = {
            "role": "system",
            "content": "Respond with ONLY a single valid JSON object. No markdown, no commentary.",
        }
        raw = await self._with_fallback([json_instruction, *messages], json_mode=True, max_tokens=max_tokens,
                                        model=model, timeout=timeout, retries=retries)
        candidate = _extract_json_object(raw)
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as exc:
            raise LLMServiceError(f"Model did not return valid JSON: {raw}") from exc


    async def vision_json(self, messages: list[dict[str, Any]], *, max_tokens: int | None = None,
                          timeout: float = 60) -> dict[str, Any]:
        """Like chat_json, for messages that carry images (content as a list with {"type": "image_url"} parts).
        Uses settings.vision_model_id with no fallback list: the NVIDIA backups are text-only models."""
        json_instruction = {
            "role": "system",
            "content": "Respond with ONLY a single valid JSON object. No markdown, no commentary.",
        }
        raw = await self._provider.chat([json_instruction, *messages], json_mode=True,
                                        max_tokens=max_tokens or settings.llm_default_max_tokens or None,
                                        model=settings.vision_model_id, timeout=timeout, retries=2)
        try:
            return json.loads(_extract_json_object(raw))
        except json.JSONDecodeError as exc:
            raise LLMServiceError(f"Model did not return valid JSON: {raw}") from exc


llm_service = LLMService(_build_provider())
