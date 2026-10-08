from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Literal

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.agents.travel_agent import TravelAgent, now_ist
from app.core.config import settings
from app.ml.travel_features import normalize_events
from app.ml.travel_predictor import get_predictor
from app.models.schemas import AgentResult
from app.services import recommendation_service as reco
from app.services.travel_history import TravelHistoryError, travel_history
from app.services.travel_service import FlightOffer, HotelOffer, TravelServiceError, search_flights, search_hotels

router = APIRouter(prefix="/ai/travel", tags=["travel"])


@router.get("/flights", response_model=list[FlightOffer])
async def flights(
    origin: str = Query(..., min_length=3, max_length=3, description="IATA airport code, e.g. JFK"),
    destination: str = Query(..., min_length=3, max_length=3, description="IATA airport code, e.g. LAX"),
    departureDate: str = Query(..., description="YYYY-MM-DD"),
    adults: int = Query(1, ge=1, le=9),
):
    try:
        return await search_flights(origin, destination, departureDate, adults=adults)
    except TravelServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/hotels", response_model=list[HotelOffer])
async def hotels(
    destination: str = Query(..., min_length=1, description="City or place name, e.g. 'Goa'"),
    checkInDate: str = Query(..., description="YYYY-MM-DD"),
    checkOutDate: str = Query(..., description="YYYY-MM-DD"),
    adults: int = Query(2, ge=1, le=9),
):
    try:
        return await search_hotels(destination, checkInDate, checkOutDate, adults=adults)
    except TravelServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


class SuggestRequest(BaseModel):
    items: list[dict]


@router.post("/suggestions")
async def suggestions(req: SuggestRequest):
    """Ranks flights/hotels by predicted interest, using the model retrained
    daily from the user's like/not-interested feedback on past results
    (falls back to a rating-based heuristic before the first model exists)."""
    return {"data": reco.suggest(req.items, domain="travel"), "modelStatus": reco.model_status("travel")["status"]}


@router.post("/train")
async def train():
    """Manual trigger for the travel interest model retrain (also runs daily via the scheduler in main.py)."""
    try:
        return await reco.train_model("travel")
    except reco.RecommendationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Next-trip model
# ---------------------------------------------------------------------------
class TravelEvent(BaseModel):
    """One travel action in the app. Only `action` is required; the rest improves predictions."""

    action: Literal["search", "flight_view", "hotel_view", "price_check", "wishlist", "booking", "cancel"]
    timestamp: datetime | None = Field(None, description="Defaults to now")
    destination: str | None = None
    origin: str | None = Field(None, description="Where the trip starts (user's home city for most trips)")
    app: str | None = Field(None, description="MakeMyTrip, Booking.com, Airbnb, Goibibo, Cleartrip, IRCTC, AURA...")
    travel_type: str | None = Field(None, description="business | leisure | family | solo | weekend | holiday")
    booking_type: str | None = Field(None, description="flight+hotel | train+hotel | flight | train | hotel")
    departure_date: str | None = Field(None, description="YYYY-MM-DD the trip starts")
    trip_duration_days: int | None = None
    flight_price: float | None = None
    train_price: float | None = None
    hotel_price: float | None = None
    booking_amount: float | None = Field(None, description="Total paid, for booking/cancel")
    is_international: bool | None = None


class LogEventRequest(TravelEvent):
    userId: str


def _parse_as_of(as_of: str | None) -> pd.Timestamp:
    if not as_of:
        return now_ist()
    try:
        return pd.Timestamp(as_of)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="asOf must be an ISO date/time") from exc


async def _events(user_id: str) -> list[dict]:
    try:
        return await travel_history.get_events(user_id)
    except TravelHistoryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/predict")
async def predict(
    userId: str = Query(..., description="Supabase user id, or a demo id such as USER_000123 (see /demo-users)"),
    asOf: str | None = Query(None, description="Predict as if it were this time (replay). Defaults to now."),
):
    """The user's likely next trip: top-3 destinations/apps/types, rough timing, spend and length."""
    as_of = _parse_as_of(asOf)
    events = await _events(userId)
    if not events:
        return {"status": "no_history", "userId": userId, "predictions": None,
                "detail": "No travel events for this user yet. Log some via POST /ai/travel/events."}
    result = await asyncio.to_thread(get_predictor().predict, events, as_of)
    result["userId"] = userId
    if asOf:  # replay: show what actually happened next, when the history has it
        ev = normalize_events(events)
        nxt = ev[(ev["action"] == "booking") & (ev["timestamp"] > as_of)].head(1)
        if len(nxt):
            n = nxt.iloc[0]
            result["actualNextBooking"] = {
                "destination": n["destination"], "app": n["app"], "travelType": n["travel_type"],
                "bookingType": n["booking_type"], "bookedOn": str(n["timestamp"]),
                "daysAfterAsOf": round((n["timestamp"] - as_of) / pd.Timedelta(days=1), 1),
                "amountInr": float(n["booking_amount"]), "tripDurationDays": int(n["trip_duration_days"])}
    return result


@router.post("/events", status_code=201)
async def log_event(req: LogEventRequest):
    """Record a travel action (search, view, booking...) so future predictions include it."""
    event = req.model_dump(exclude={"userId"}, mode="json")
    event["timestamp"] = event["timestamp"] or now_ist().isoformat()
    try:
        stored_in = await travel_history.add_event(req.userId, event)
    except TravelHistoryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"stored": True, "storedIn": stored_in, "event": event}


@router.delete("/events/session")
async def clear_session_events(userId: str = Query(...)):
    """Forget events logged in memory for this user (handy when testing with demo users)."""
    return {"cleared": travel_history.clear_memory(userId)}


@router.get("/demo-users")
async def demo_users(persona: str | None = Query(None, description="e.g. business_traveler, family_traveler")):
    """Synthetic users with history, for trying the model and agent."""
    if not settings.travel_demo_enabled:
        return []
    path = settings.travel_demo_events.replace("demo_travel_events.csv", "demo_travel_users.json")
    users = json.loads(open(path, encoding="utf-8").read())
    return [u for u in users if not persona or u["persona"] == persona]


class AskRequest(BaseModel):
    userId: str
    message: str
    asOf: str | None = None


@router.post("/ask", response_model=AgentResult)
async def ask_travel_agent(req: AskRequest):
    """Run only the Travel Agent (no Coordinator/LLM reply) to see its raw notes and data."""
    context = {"userId": req.userId}
    if req.asOf:
        context["asOf"] = str(_parse_as_of(req.asOf))
    return await TravelAgent().run(req.message, context)
