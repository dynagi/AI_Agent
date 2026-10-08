from __future__ import annotations

from abc import ABC, abstractmethod

from app.models.schemas import AgentResult
from app.services.llm_service import llm_service


class BaseAgent(ABC):
    """Every specialized agent implements identity + a scoped run() call.
    Agents never call each other directly — only the Coordinator invokes them."""

    name: str

    @abstractmethod
    async def run(self, situation: str, context: dict) -> AgentResult:
        raise NotImplementedError

    async def _ask_llm(self, system_prompt: str, situation: str) -> str:
        return await llm_service.chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": situation},
            ]
        )
