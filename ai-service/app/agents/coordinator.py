from __future__ import annotations

import asyncio
import re

from app.agents.domain_agents import AGENT_REGISTRY
from app.models.schemas import AgentResult
from app.services.travel_places import cities_in
from app.shopping.session import sessions

# Simple keyword routing. A production system would use the LLM itself to
# select relevant agents, but keeping this deterministic keeps the
# Coordinator auditable and cheap for the common case.
_KEYWORD_MAP = {
    "travel": ["travel", "flight", "flights", "fly", "trip", "hotel", "hotels", "interview", "vacation", "holiday",
               "getaway", "itinerary", "airport", "ticket", "tickets", "stay", "visit", "weekend away"],
    "finance": ["budget", "cost", "money", "price", "finance"],
    "productivity": ["schedule", "task", "meeting", "deadline", "work"],
    "shopping": ["buy", "shop", "shopping", "purchase", "product", "products", "order", "reorder", "restock", "cart",
                 "grocery", "groceries", "running out", "blinkit", "zepto", "instamart", "bigbasket", "jiomart",
                 "amazon", "flipkart", "myntra", "meesho", "nykaa", "deliver"],
    "research": ["research", "find", "learn", "summarize"],
    "calendar": ["calendar", "conflict", "event", "tomorrow", "today"],
    "wellness": ["sleep", "health", "hydration", "workout", "stress"],
    "communication": ["email", "message", "reply", "call"],
}


def select_agents(situation: str) -> list[str]:
    lowered = situation.lower()
    # whole words only, so e.g. "stay" doesn't fire on "stayed" and "fly" not on "butterfly"
    matched = [name for name, keywords in _KEYWORD_MAP.items()
               if any(re.search(rf"\b{re.escape(k)}\b", lowered) for k in keywords)]
    if "travel" not in matched and cities_in(situation):
        matched.insert(0, "travel")
    # "find me flights/hotels" is a travel search, not a research question
    if "travel" in matched and "research" in matched and not re.search(r"\b(research|learn|summarize)\b", lowered):
        matched.remove("research")
    # "find/compare protein powder" or "order milk" is a shopping request, not research
    if "shopping" in matched and "research" in matched and not re.search(r"(research|learn|summarize)", lowered):
        matched.remove("research")
    return matched or ["productivity"]


class Coordinator:
    """AURA Coordinator: routes a situation to relevant agents, runs them
    concurrently, and aggregates structured results. Never lets one agent
    call another directly."""

    async def consult(self, situation: str, context: dict | None = None) -> list[AgentResult]:
        context = context or {}
        # "Zepto" / "the cheaper one" / "yes" carry no keyword: route them by the conversation they belong to
        if sessions.pending(context.get("userId")):
            agent_names = ["shopping"]
        else:
            agent_names = select_agents(situation)
        agents = [AGENT_REGISTRY[name]() for name in agent_names if name in AGENT_REGISTRY]

        results = await asyncio.gather(*(agent.run(situation, context) for agent in agents))
        return list(results)


coordinator = Coordinator()
