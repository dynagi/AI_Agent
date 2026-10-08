from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.agents.coordinator import coordinator
from app.models.schemas import (
    ChatRequest,
    ChatResponse,
    DecideRequest,
    DecideResponse,
    DecisionOption,
    PlanRequest,
    PlanResponse,
    PlanTask,
)
from app.services.llm_service import LLMServiceError, llm_service

router = APIRouter(prefix="/ai", tags=["ai"])


@router.get("/health")
async def health():
    return {"status": "ok", "service": "aura-python-ai"}


def _agent_notes(results) -> str:
    blocks = []
    for r in results:
        parts = list(r.insights)
        if r.options:
            parts.append("Options: " + "; ".join(r.options))
        if r.constraints:
            parts.append("Constraints: " + "; ".join(r.constraints))
        blocks.append(f"[{r.agent}] " + "\n".join(parts))
    return "\n\n".join(blocks)


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    agent_results = await coordinator.consult(req.message, {"userId": req.userId})
    agents_consulted = [r.agent for r in agent_results]

    # The shopping agent's questions and confirmations are precise (stores, prices, where the numbers came from):
    # they go out verbatim, not paraphrased by the chat model.
    direct = next((r.data.get("directReply") for r in agent_results if r.agent == "shopping" and r.data.get("directReply")), None)
    if direct:
        return ChatResponse(reply=direct, agentsConsulted=agents_consulted,
                            agentData={r.agent: r.data for r in agent_results if r.data})

    context_summary = _agent_notes(agent_results)
    try:
        reply = await llm_service.chat(
            [
                {
                    "role": "system",
                    "content": (
                        "You are AURA, a JARVIS-style personal AI. Combine the specialist agent "
                        "notes below into one concise, helpful reply. Do not expose raw chain-of-thought. "
                        "Only quote prices, flights, hotels and dates that appear in the notes; never invent "
                        "them. Present model forecasts as suggestions, and if a constraint says information "
                        "is missing, ask the user for it."
                    ),
                },
                {"role": "user", "content": f"User message: {req.message}\n\nAgent notes:\n{context_summary}"},
            ]
        )
    except LLMServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return ChatResponse(reply=reply, agentsConsulted=agents_consulted,
                        agentData={r.agent: r.data for r in agent_results if r.data})


@router.post("/plan", response_model=PlanResponse)
async def plan(req: PlanRequest):
    try:
        raw = await llm_service.chat_json(
            [
                {
                    "role": "system",
                    "content": (
                        'Break the goal into a task graph. Respond as JSON: '
                        '{"tasks": [{"title": str, "agent": str|null, "dependencies": [str]}]}'
                    ),
                },
                {"role": "user", "content": req.goal},
            ]
        )
    except LLMServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    tasks = [PlanTask(**t) for t in raw.get("tasks", [])]
    return PlanResponse(tasks=tasks)


@router.post("/decide", response_model=DecideResponse)
async def decide(req: DecideRequest):
    agent_results = await coordinator.consult(req.situation, {"userId": req.userId, **req.context})
    agents_consulted = [r.agent for r in agent_results]
    notes = _agent_notes(agent_results)

    try:
        raw = await llm_service.chat_json(
            [
                {
                    "role": "system",
                    "content": (
                        "You are AURA's Decision Engine. Given the situation and agent notes, propose "
                        '2-3 options. Respond as JSON: {"options": [{"title": str, "tradeoffs": str, '
                        '"risk": str}], "recommendation": str}'
                    ),
                },
                {"role": "user", "content": f"Situation: {req.situation}\n\nAgent notes:\n{notes}"},
            ]
        )
    except LLMServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    options = [DecisionOption(**o) for o in raw.get("options", [])]
    return DecideResponse(options=options, recommendation=raw.get("recommendation", ""), agentsConsulted=agents_consulted)
