from __future__ import annotations

from app.agents.base import BaseAgent
from app.agents.shopping_agent import ShoppingAgent
from app.agents.travel_agent import TravelAgent
from app.models.schemas import AgentResult
from app.services.llm_service import LLMServiceError


def _make_agent(agent_name: str, system_prompt: str) -> type[BaseAgent]:
    class _Agent(BaseAgent):
        name = agent_name

        async def run(self, situation: str, context: dict) -> AgentResult:
            try:
                text = await self._ask_llm(system_prompt, situation)
                return AgentResult(agent=self.name, status="completed", insights=[text])
            except LLMServiceError as exc:
                return AgentResult(agent=self.name, status="failed", insights=[str(exc)])

    _Agent.__name__ = f"{agent_name.title()}Agent"
    return _Agent


FinanceAgent = _make_agent(
    "finance",
    "You are AURA's Finance Agent. Assess budget impact concisely. If the context has a `plan`, it was computed by the app "
    "from the user's own income, rent, bills, spending and goals: explain and use those numbers exactly, never invent or "
    "recalculate figures, and say what is missing when the plan lacks data. Suggest, never instruct: you cannot move money "
    "and this is not regulated financial advice.",
)
ProductivityAgent = _make_agent(
    "productivity", "You are AURA's Productivity Agent. Identify scheduling and task-priority insights."
)
ResearchAgent = _make_agent("research", "You are AURA's Research Agent. Summarize relevant information concisely.")
CalendarAgent = _make_agent("calendar", "You are AURA's Calendar Agent. Detect conflicts and buffer requirements.")
WellnessAgent = _make_agent("wellness", "You are AURA's Wellness Agent. Give careful, non-diagnostic guidance.")
CommunicationAgent = _make_agent(
    "communication", "You are AURA's Communication Agent. Draft concise, clear messages when asked."
)

AGENT_REGISTRY: dict[str, type[BaseAgent]] = {
    agent_cls.name: agent_cls
    for agent_cls in [
        TravelAgent,
        FinanceAgent,
        ProductivityAgent,
        ShoppingAgent,
        ResearchAgent,
        CalendarAgent,
        WellnessAgent,
        CommunicationAgent,
    ]
}
