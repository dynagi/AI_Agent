"""Travel model + agent tests. Offline: the LLM and SerpAPI are mocked, the demo history is real."""
from __future__ import annotations

import asyncio

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.agents import travel_agent as ta
from app.agents.coordinator import select_agents
from app.main import app
from app.ml.travel_features import normalize_events
from app.ml.travel_predictor import get_predictor
from app.services import travel_service
from app.services.llm_service import LLMServiceError
from app.services.travel_history import travel_history
from app.services.travel_service import FlightOffer, HotelOffer

DEMO = "USER_000030"  # business traveller from Pune, 30 trips, mostly Chandigarh
AS_OF = "2026-09-30T10:00:00"
client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_memory():
    travel_history.clear_memory(DEMO)
    yield
    travel_history.clear_memory(DEMO)


@pytest.fixture
def fake_search(monkeypatch):
    calls = {}

    async def flights(origin, destination, date, *, adults=1, max_results=15):
        calls["flights"] = (origin, destination, date, adults)
        return [FlightOffer(price=7000, origin=origin, destination=destination, departureAt=f"{date} 06:00",
                            arrivalAt=f"{date} 08:30", airline="IndiGo", flightNumber="6E 1")]

    async def hotels(destination, check_in, check_out, *, adults=2, max_results=15):
        calls["hotels"] = (destination, check_in, check_out, adults)
        return [HotelOffer(name="Test Inn", pricePerNight=2000, totalPrice=4000, rating=4.2,
                           checkInDate=check_in, checkOutDate=check_out)]

    monkeypatch.setattr(travel_service, "search_flights", flights)
    monkeypatch.setattr(travel_service, "search_hotels", hotels)
    return calls


def fake_llm(monkeypatch, intent: dict | None):
    async def chat_json(messages):
        if intent is None:
            raise LLMServiceError("offline")
        return intent

    monkeypatch.setattr(ta.llm_service, "chat_json", chat_json)


# ---- model ----
def test_predict_demo_user_returns_ranked_top3():
    events = asyncio.run(travel_history.get_events(DEMO))
    out = get_predictor().predict(events, pd.Timestamp(AS_OF))
    assert out["status"] == "ok"
    dest = out["predictions"]["destination"]
    assert len(dest) == 3
    probs = [d["probability"] for d in dest]
    assert probs == sorted(probs, reverse=True) and sum(probs) <= 1.0
    assert out["history"]["homeCity"] == "Pune"
    assert out["predictions"]["daysUntilNextBooking"] >= 0


def test_cold_start_without_bookings():
    events = [{"timestamp": "2026-09-01T10:00:00", "action": "search", "destination": "Goa", "origin": "Pune"}]
    out = get_predictor().predict(events, pd.Timestamp(AS_OF))
    assert out["status"] == "cold_start"
    assert out["activePlanning"]["destination"] == "Goa"


def test_timezone_aware_events_are_converted_to_india_time():
    ev = normalize_events([{"timestamp": "2026-09-01T04:30:00Z", "action": "search"}])
    assert ev["timestamp"].iloc[0] == pd.Timestamp("2026-09-01T10:00:00")


# ---- routing ----
@pytest.mark.parametrize("text,expected", [
    ("find me flights to Goa next week", True),
    ("plan a weekend in Udaipur", True),
    ("what a lovely butterfly", False),
    ("I stayed late at work", False),
])
def test_travel_routing(text, expected):
    agents = select_agents(text)
    assert ("travel" in agents) is expected
    if "find me flights" in text:
        assert "research" not in agents


# ---- agent ----
def test_agent_searches_with_history_defaults(monkeypatch, fake_search):
    fake_llm(monkeypatch, {"intent": "plan_trip", "destination": "Chandigarh", "depart_date": "2026-10-09"})
    res = asyncio.run(ta.TravelAgent().run("flight and hotel to Chandigarh next Friday",
                                           {"userId": DEMO, "asOf": AS_OF}))
    # origin comes from the user's home city, return date from the model's predicted trip length
    assert fake_search["flights"][:3] == ("PNQ", "IXC", "2026-10-09")
    nights = res.data["profile"]["predictions"]["expectedTripDurationDays"]
    assert fake_search["hotels"][2] == str(pd.Timestamp("2026-10-09").date() + pd.Timedelta(days=nights))
    assert "Live flights" in res.insights[0] and "Test Inn" in res.insights[0]


def test_agent_uses_active_planning_when_request_is_vague(monkeypatch, fake_search):
    for action in ["search", "price_check"]:
        client.post("/ai/travel/events", json={"userId": DEMO, "action": action, "destination": "Goa", "origin": "Pune",
                                               "departure_date": "2026-10-16", "timestamp": "2026-09-29T20:00:00"})
    fake_llm(monkeypatch, {"intent": "plan_trip", "destination": None, "depart_date": None})
    res = asyncio.run(ta.TravelAgent().run("book my trip", {"userId": DEMO, "asOf": AS_OF}))
    assert fake_search["flights"][:3] == ("PNQ", "GOI", "2026-10-16")
    assert fake_search["hotels"][0] == "Goa"


def test_agent_asks_for_date_instead_of_guessing(monkeypatch, fake_search):
    fake_llm(monkeypatch, {"intent": "flights", "destination": "Goa", "depart_date": None})
    res = asyncio.run(ta.TravelAgent().run("flights to Goa", {"userId": DEMO, "asOf": AS_OF}))
    assert not fake_search
    assert any("travel date" in c for c in res.constraints)


def test_agent_suggests_forecast_destinations(monkeypatch, fake_search):
    fake_llm(monkeypatch, {"intent": "suggest"})
    res = asyncio.run(ta.TravelAgent().run("where should I go next?", {"userId": DEMO, "asOf": AS_OF}))
    top = res.data["profile"]["predictions"]["destination"][0]["value"]
    assert res.options[0].startswith(top)


def test_agent_works_without_llm(monkeypatch, fake_search):
    fake_llm(monkeypatch, None)
    res = asyncio.run(ta.TravelAgent().run("find flights from Pune to Goa", {"userId": DEMO, "asOf": AS_OF}))
    assert res.data["intent"]["destination"] == "Goa" and res.data["intent"]["origin"] == "Pune"
    assert res.status == "completed"


def test_agent_without_history_or_user(monkeypatch, fake_search):
    fake_llm(monkeypatch, {"intent": "suggest"})
    res = asyncio.run(ta.TravelAgent().run("where should I go?", {}))
    assert res.options  # generic suggestions


# ---- API ----
def test_predict_endpoint_replay_shows_actual():
    r = client.get("/ai/travel/predict", params={"userId": DEMO, "asOf": "2026-05-15T10:00"})
    assert r.status_code == 200
    body = r.json()
    assert body["actualNextBooking"]["destination"]
    assert len(body["predictions"]["destination"]) == 3


def test_predict_unknown_user_has_no_history():
    r = client.get("/ai/travel/predict", params={"userId": "nobody"})
    assert r.json()["status"] == "no_history"


def test_logged_event_shows_up_as_planning():
    r = client.post("/ai/travel/events", json={"userId": DEMO, "action": "search", "destination": "Leh",
                                               "origin": "Pune", "departure_date": "2026-10-20"})
    assert r.status_code == 201 and r.json()["storedIn"] == "memory"
    body = client.get("/ai/travel/predict", params={"userId": DEMO}).json()
    assert body["activePlanning"]["destination"] == "Leh"
