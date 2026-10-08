from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str
    userId: str
    conversationId: str | None = None


class ChatResponse(BaseModel):
    reply: str
    agentsConsulted: list[str] = Field(default_factory=list)
    # structured per-agent output for the UI (e.g. travel forecast, flight/hotel offers)
    agentData: dict[str, Any] = Field(default_factory=dict)


class PlanRequest(BaseModel):
    goal: str
    userId: str


class PlanTask(BaseModel):
    title: str
    agent: str | None = None
    dependencies: list[str] = Field(default_factory=list)


class PlanResponse(BaseModel):
    tasks: list[PlanTask]


class DecideRequest(BaseModel):
    situation: str
    userId: str
    context: dict[str, Any] = Field(default_factory=dict)


class DecisionOption(BaseModel):
    title: str
    tradeoffs: str
    risk: str = "low"


class DecideResponse(BaseModel):
    options: list[DecisionOption]
    recommendation: str
    agentsConsulted: list[str] = Field(default_factory=list)


class AgentResult(BaseModel):
    agent: str
    status: str = "completed"
    insights: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    options: list[str] = Field(default_factory=list)
    required_approval: bool = False
    data: dict[str, Any] = Field(default_factory=dict)
