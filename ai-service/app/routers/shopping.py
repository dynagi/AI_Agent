from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Literal

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.agents.shopping_agent import ShoppingAgent, load_policy, save_policy
from app.core.config import settings
from app.ml.shopping_predictor import get_predictor, now_ist, retrain_scheduler
from app.models.schemas import AgentResult
from app.services import recommendation_service as reco
from app.services.shopping_browser import StepAction, StepRequest, next_step, resolve_store
from app.services.shopping_history import ShoppingHistoryError, shopping_history
from app.shopping.policy import ShoppingPolicy
from app.shopping.preferences import build_preferences
from app.shopping.providers import registry
from app.shopping.session import sessions
from app.services.shopping_service import ShoppingResult, ShoppingServiceError, search_products

router = APIRouter(prefix="/ai/shopping", tags=["shopping"])


@router.get("/search", response_model=list[ShoppingResult])
async def search(q: str = Query(..., min_length=1), max_results: int = Query(20, ge=1, le=50)):
    try:
        return await search_products(q, max_results=max_results)
    except ShoppingServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


class SuggestRequest(BaseModel):
    products: list[dict]


@router.post("/suggestions")
async def suggestions(req: SuggestRequest):
    """Ranks candidate products by predicted interest, using whatever the
    daily-retrained model has learned from the user's interested /
    not-interested feedback so far (falls back to a rating-based heuristic
    before the first model exists)."""
    return {"data": reco.suggest(req.products), "modelStatus": reco.model_status()["status"]}


@router.post("/train")
async def train():
    """Manual trigger for the interest model retrain (also runs daily via
    the scheduler in main.py)."""
    try:
        return await reco.train_model()
    except reco.RecommendationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Next-purchase model
# ---------------------------------------------------------------------------
ShoppingAction = Literal["search", "view", "wishlist", "add_to_cart", "order", "cancel", "not_interested"]


class ShoppingEvent(BaseModel):
    """One shopping action. Only `action` and `name` are required; the rest improves predictions."""

    action: ShoppingAction
    name: str = Field(..., min_length=1, max_length=120, description="Product as the user saw/said it")
    timestamp: datetime | None = Field(None, description="Defaults to now")
    category: str | None = None
    app: str | None = Field(None, description="Blinkit, Zepto, Swiggy Instamart, BigBasket, Amazon, Flipkart...")
    qty: float | None = Field(None, ge=0, le=100)
    price: float | None = Field(None, ge=0, description="Unit price, INR")
    source: str | None = Field(None, description="app | agent_command | cart_agent")


class LogEventsRequest(BaseModel):
    userId: str
    events: list[ShoppingEvent] = Field(..., min_length=1, max_length=100)


def _parse_as_of(as_of: str | None) -> pd.Timestamp:
    if not as_of:
        return now_ist()
    try:
        return pd.Timestamp(as_of)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="asOf must be an ISO date/time") from exc


@router.get("/predict")
async def predict(
    userId: str = Query(..., description="Supabase user id, or a demo id such as USER_000123 (see /demo-users)"),
    asOf: str | None = Query(None, description="Predict as if it were this time (replay). Defaults to now."),
):
    """What the user will likely buy in the next 7 days, from which store, when, and roughly for how much."""
    try:
        events = await shopping_history.get_events(userId)
    except ShoppingHistoryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    as_of = _parse_as_of(asOf)
    result = await asyncio.to_thread(get_predictor().predict, events, as_of)
    result["userId"] = userId
    return result


@router.post("/events", status_code=201)
async def log_events(req: LogEventsRequest):
    """Record shopping actions so the user's predictions (immediately) and the model (next retrain) learn them."""
    ts = now_ist().isoformat()
    events = [{**e.model_dump(mode="json", exclude_none=True), "timestamp": e.timestamp.isoformat() if e.timestamp else ts}
              for e in req.events]
    try:
        stored_in = await shopping_history.add_events(req.userId, events)
    except ShoppingHistoryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    retrain = retrain_scheduler.request(f"{len(events)} events logged") \
        if any(e.action in ("order", "add_to_cart") for e in req.events) else None
    return {"stored": len(events), "storedIn": stored_in, "retrain": retrain}


@router.get("/model")
async def model_status():
    """Which model is serving (base or fine-tuned), what it was trained on, and the last retrain."""
    p = get_predictor()
    return {**p.meta, "baseMetrics": p.spec.get("metrics"), "lastRetrainResult": retrain_scheduler.last_result}


@router.post("/model/retrain")
async def retrain_now():
    """Fine-tune on all real users' history right now (normally scheduled automatically after each command)."""
    return await retrain_scheduler.run_now()


@router.delete("/events/session")
async def clear_session_events(userId: str = Query(...)):
    """Forget events logged in memory for this user (handy when testing with demo users)."""
    return {"cleared": shopping_history.clear_memory(userId)}


@router.get("/demo-users")
async def demo_users(persona: str | None = Query(None, description="bachelor, family, health_enthusiast...")):
    """Synthetic users with shopping history, for trying the model and agent."""
    if not settings.shopping_demo_enabled:
        return []
    path = Path(settings.shopping_demo_events).with_name("demo_shopping_users.json")
    users = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    return [u for u in users if not persona or u["persona"] == persona]


class AskRequest(BaseModel):
    userId: str
    message: str
    asOf: str | None = None


@router.post("/ask", response_model=AgentResult)
async def ask_shopping_agent(req: AskRequest):
    """Run only the Shopping Agent (no Coordinator reply) to see its notes, predictions and cart job."""
    context = {"userId": req.userId}
    if req.asOf:
        context["asOf"] = str(_parse_as_of(req.asOf))
    return await ShoppingAgent().run(req.message, context)


# ---------------------------------------------------------------------------
# Cart agent (drives the store's website on the phone, one step at a time)
# ---------------------------------------------------------------------------
@router.get("/browse/store")
async def browse_store(name: str = Query(..., min_length=1)):
    """Where the cart agent should start for a store (known stores: their site; others: a web search)."""
    return resolve_store(name)


@router.post("/browse/step", response_model=StepAction)
async def browse_step(req: StepRequest):
    """Given a snapshot of the current page, the single next action. Never pays or checks out."""
    return await next_step(req)


# ---------------------------------------------------------------------------
# Shopping assistant: intent -> memory -> options -> decision (ask / confirm / act)
# ---------------------------------------------------------------------------
class AssistRequest(BaseModel):
    userId: str
    message: str = Field(..., min_length=1, max_length=1500)
    installedStores: list[str] | None = Field(None, description="Shopping apps on the user's phone, when known")


@router.post("/assist")
async def assist(req: AssistRequest):
    """One conversational turn with the Shopping Agent, without the general chat model around it. `handled` is false
    when the message wasn't an order or an answer to a shopping question (the caller then uses normal chat)."""
    result = await ShoppingAgent().run(req.message, {"userId": req.userId, "installedStores": req.installedStores})
    a = result.data.get("assist")
    if not a:
        return {"handled": False}
    return {"handled": True, **a, "cartOrder": result.data.get("cartOrder"), "providers": result.data.get("providers")}


@router.delete("/assist/session")
async def assist_reset(userId: str = Query(...)):
    """Drop the shopping conversation in progress (the pending question)."""
    sessions.clear(userId)
    return {"cleared": True}


@router.get("/policy", response_model=ShoppingPolicy)
async def get_policy(userId: str = Query(...)):
    """The user's purchase rules: what needs a confirmation, and what may be ordered automatically."""
    return await load_policy(userId)


@router.put("/policy", response_model=ShoppingPolicy)
async def put_policy(policy: ShoppingPolicy, userId: str = Query(...)):
    try:
        await save_policy(userId, policy)
    except ShoppingHistoryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return policy


@router.get("/preferences")
async def preferences(userId: str = Query(...)):
    """What AURA has learnt about this user's shopping: usual products, stores, rhythm, price-vs-speed, with
    confidence. Built from order history and past decisions."""
    try:
        events = await shopping_history.get_events(userId)
    except ShoppingHistoryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return build_preferences(events).to_dict()


@router.get("/providers")
async def providers():
    """Every shopping provider AURA knows, and what its integration can really do."""
    return [{"name": p.name, "kind": p.kind, "androidPackage": p.android_package, "capabilities": p.capabilities}
            for p in registry.all()]
