"""Screen agent endpoints: the phone sends what is on screen (and sometimes a screenshot) and gets back one action,
or the products visible in a screenshot with live prices. The phone does all the acting."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import screen_agent

router = APIRouter(prefix="/ai/screen", tags=["screen"])

# a downscaled JPEG of a phone screen is ~100-300 KB; base64 is a third bigger
MAX_IMAGE_CHARS = 1_400_000


class StepRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=500)
    app: str = Field(default="", max_length=80)
    elements: list[dict[str, Any]] = Field(default_factory=list, max_length=250)
    pageText: str = Field(default="", max_length=4000)
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    step: int = Field(default=0, ge=0, le=1000)
    screenshot: str | None = Field(default=None, max_length=MAX_IMAGE_CHARS, description="base64 JPEG of the screen")


class VisualSearchRequest(BaseModel):
    image: str = Field(min_length=100, max_length=MAX_IMAGE_CHARS, description="base64 JPEG/PNG of the screen")
    hint: str = Field(default="", max_length=300, description="What the user said, e.g. 'find the red shoes'")
    maxResults: int = Field(default=6, ge=1, le=12)


@router.post("/step")
async def step(req: StepRequest) -> dict[str, Any]:
    """The single next action toward the goal. Never pays, never touches passwords; risky presses are flagged."""
    try:
        return await screen_agent.next_step(req.goal, req.app, req.elements, req.pageText, req.history, req.step, req.screenshot)
    except screen_agent.ScreenStepError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/visual-search")
async def visual_search(req: VisualSearchRequest) -> dict[str, Any]:
    """What product is in this screenshot, and where to buy it (live prices, cheapest first)."""
    try:
        return await screen_agent.visual_search(req.image, req.hint, req.maxResults)
    except screen_agent.ScreenStepError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
