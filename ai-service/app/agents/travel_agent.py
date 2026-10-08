"""AURA's Travel Agent.

Per request it (1) forecasts the user's next trip with the trained travel model, (2) works out
what they are asking for (route, dates, travellers, budget), filling gaps from their history and
the forecast, and (3) runs live Google Flights / Hotels searches when it has enough to search.
It returns grounded notes for the Coordinator's reply plus structured data for the UI.
It never books anything; booking stays with the user.
"""
from __future__ import annotations

import asyncio
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
import structlog

from app.agents.base import BaseAgent
from app.ml.travel_predictor import get_predictor
from app.models.schemas import AgentResult
from app.services import travel_service
from app.services.llm_service import LLMServiceError, llm_service
from app.services.travel_history import TravelHistoryError, travel_history
from app.services.travel_places import airport_for, canonical_city, cities_in

logger = structlog.get_logger()
IST = ZoneInfo("Asia/Kolkata")
INTENTS = {"flights", "hotels", "plan_trip", "suggest", "general"}

_INTENT_PROMPT = """You extract travel requests for an Indian travel assistant. Today is {today} ({weekday}).
Return JSON with exactly these keys:
{{"intent": "flights" | "hotels" | "plan_trip" | "suggest" | "general",
  "origin": city or null, "destination": city or null,
  "origin_iata": 3-letter airport code or null, "destination_iata": 3-letter airport code or null,
  "depart_date": "YYYY-MM-DD" or null, "return_date": "YYYY-MM-DD" or null,
  "adults": integer or null, "budget_inr": number or null}}
intent: flights = wants flights; hotels = wants a place to stay; plan_trip = wants a trip planned or both;
suggest = asks where to go / for ideas; general = anything else about travel.
Resolve relative dates ("next Friday", "this weekend", "15th") against today. Never invent a city or date
the user did not say. Convert budgets to INR numbers ("30k" -> 30000)."""


def now_ist() -> pd.Timestamp:
    return pd.Timestamp(datetime.now(IST).replace(tzinfo=None))


def _parse_date(value, today: date) -> date | None:
    try:
        d = date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None
    return d if d >= today else None


def _fallback_intent(text: str) -> dict:
    """Used when the LLM is unavailable: cities by position, simple 'from X' / 'to Y' cues."""
    lowered = text.lower()
    cities = cities_in(text)
    origin = next((c for c in cities if re.search(rf"\bfrom\s+{re.escape(c.lower())}\b", lowered)), None)
    dest = next((c for c in cities if c != origin), None)
    if "flight" in lowered or "fly" in lowered:
        intent = "flights"
    elif "hotel" in lowered or "stay" in lowered:
        intent = "hotels"
    elif dest:
        intent = "plan_trip"
    elif any(k in lowered for k in ("where", "suggest", "idea", "recommend")):
        intent = "suggest"
    else:
        intent = "general"
    return {"intent": intent, "origin": origin, "destination": dest}


def _pct(p: float) -> str:
    return f"{round(p * 100)}%"


def _inr(x: float | None) -> str:
    return "n/a" if x is None else f"₹{x:,.0f}"


class TravelAgent(BaseAgent):
    name = "travel"

    async def run(self, situation: str, context: dict) -> AgentResult:
        as_of = pd.Timestamp(context["asOf"]) if context.get("asOf") else now_ist()
        today = as_of.date()
        profile, intent = await asyncio.gather(
            self._profile(context.get("userId"), as_of), self._intent(situation, today)
        )
        notes: list[str] = []
        constraints: list[str] = []
        options: list[str] = []
        data: dict = {"intent": intent, "profile": profile}
        preds = (profile or {}).get("predictions")
        history = (profile or {}).get("history") or {}
        planning = (profile or {}).get("activePlanning")

        # ---- what we know about this traveller ----
        if preds:
            last = history["lastTrip"]
            favs = ", ".join(f"{f['destination']} ({f['trips']}x)" for f in history["favouriteDestinations"])
            notes.append(
                f"Traveller profile: home {history['homeCity']}; {history['totalBookings']} past trips; "
                f"favourites {favs}; usually {history['usualTravelType']} trips booked on {history['preferredApp']}; "
                f"average spend {_inr(history['averageBookingAmountInr'])}; last trip {last['destination']} "
                f"(booked {last['bookedOn']})."
            )
            dest_s = ", ".join(f"{d['value']} {_pct(d['probability'])}" for d in preds["destination"])
            notes.append(
                f"Model forecast for the next trip (suggestions, not certainties): destinations {dest_s}; "
                f"app {preds['app'][0]['value']} {_pct(preds['app'][0]['probability'])}; "
                f"type {preds['travelType'][0]['value']} {_pct(preds['travelType'][0]['probability'])}; "
                f"booking {preds['bookingType'][0]['value']} {_pct(preds['bookingType'][0]['probability'])}; "
                f"likely to book in roughly {preds['daysUntilNextBooking']:.0f} days (rough estimate); "
                f"typical spend ~{_inr(preds['expectedBookingAmountInr'])}; "
                f"~{preds['expectedTripDurationDays']} days long."
            )
        elif profile and profile.get("status") == "cold_start":
            notes.append("No past bookings on record yet, so there is no personalised forecast.")
        if planning and planning.get("destination"):
            when = f", looking at travel around {planning['travelDate']}" if planning.get("travelDate") else ""
            notes.append(f"Currently planning: {planning['destination']} "
                         f"({planning.get('searches', 0)} searches{when}).")

        # ---- resolve the request, filling gaps from history and the forecast ----
        kind = intent.get("intent") if intent.get("intent") in INTENTS else "general"
        dest = canonical_city(intent.get("destination"))
        origin = canonical_city(intent.get("origin")) or history.get("homeCity")
        depart = _parse_date(intent.get("depart_date"), today)
        ret = _parse_date(intent.get("return_date"), today)
        adults = int(intent.get("adults") or 0) or None
        budget = intent.get("budget_inr")

        if dest is None and planning and planning.get("destination") and kind in ("flights", "hotels", "plan_trip"):
            dest = planning["destination"]
            notes.append(f"No destination given; assuming {dest}, which they are currently researching.")
        if depart is None and dest and planning and planning.get("destination") == dest and planning.get("travelDate"):
            depart = _parse_date(planning["travelDate"], today)
            if depart:
                notes.append(f"No date given; using {depart}, the date they have been searching for.")
        if depart and ret is None and kind in ("hotels", "plan_trip"):
            nights = preds["expectedTripDurationDays"] if preds else 3
            ret = depart + timedelta(days=nights)
            notes.append(f"No return date given; assuming {nights} nights "
                         f"({'their typical trip length' if preds else 'default'}), checking out {ret}.")
        if adults is None:
            adults = 2 if (preds and preds["travelType"][0]["value"] == "family") or kind == "hotels" else 1

        if kind == "suggest" or (kind == "plan_trip" and not dest):
            if preds:
                options += [f"{d['value']} ({_pct(d['probability'])} match with their habits)"
                            for d in preds["destination"]]
            else:
                options += ["Goa", "Udaipur", "Rishikesh"]
                notes.append("Suggestions are generic popular picks because there is no travel history yet.")

        # ---- live search ----
        want_flights = kind in ("flights", "plan_trip") and dest is not None
        want_hotels = kind in ("hotels", "plan_trip") and dest is not None
        if (want_flights or want_hotels) and depart is None:
            constraints.append(f"Need a travel date before searching {dest}; ask the user when they want to go.")
            want_flights = want_hotels = False

        flights_task = hotels_task = None
        if want_flights:
            o_code, _ = airport_for(origin)
            d_code, d_note = airport_for(dest)
            o_code = o_code or (intent.get("origin_iata") or "").upper() or None
            d_code = d_code or (intent.get("destination_iata") or "").upper() or None
            if not o_code or not d_code:
                constraints.append(f"Could not find airports for {origin or 'the origin'} -> {dest}.")
            elif o_code == d_code:
                constraints.append(f"{origin} and {dest} share an airport ({o_code}); suggest train or road.")
            else:
                if d_note:
                    notes.append(f"{dest} has no direct airport; nearest is {d_note}.")
                data["flightSearch"] = {"origin": o_code, "destination": d_code, "date": str(depart), "adults": adults}
                flights_task = travel_service.search_flights(o_code, d_code, str(depart), adults=adults, max_results=8)
        if want_hotels:
            data["hotelSearch"] = {"destination": dest, "checkIn": str(depart), "checkOut": str(ret), "adults": adults}
            hotels_task = travel_service.search_hotels(dest, str(depart), str(ret), adults=adults, max_results=8)

        flights, hotels = await asyncio.gather(_safe(flights_task, constraints, "Flight"),
                                               _safe(hotels_task, constraints, "Hotel"))
        if flights is not None:
            data["flights"] = [f.model_dump() for f in flights[:5]]
            if flights:
                lines = [f"{i}) {f.airline or '?'} {f.flightNumber or ''} {_inr(f.price)}, {f.departureAt} -> "
                         f"{f.arrivalAt}, {'non-stop' if f.stops == 0 else f'{f.stops} stop(s)'}"
                         for i, f in enumerate(flights[:3], 1)]
                notes.append(f"Live flights {data['flightSearch']['origin']}->{data['flightSearch']['destination']} "
                             f"on {depart}, cheapest first: " + "; ".join(lines))
                if budget and flights[0].price > float(budget):
                    constraints.append(f"Cheapest flight {_inr(flights[0].price)} is over the {_inr(float(budget))} budget.")
            else:
                notes.append(f"No flights found for that route on {depart}.")
        if hotels is not None:
            data["hotels"] = [h.model_dump() for h in hotels[:5]]
            priced = [h for h in hotels if h.totalPrice is not None]
            if priced:
                typical = preds["expectedBookingAmountInr"] if preds else None
                lines = [f"{i}) {h.name} {_inr(h.pricePerNight)}/night, total {_inr(h.totalPrice)}"
                         f"{f', {h.rating}★' if h.rating else ''}" for i, h in enumerate(priced[:3], 1)]
                notes.append(f"Live hotels in {dest} {depart} to {ret}, cheapest first: " + "; ".join(lines))
                if typical:
                    notes.append(f"For reference their usual total trip spend is about {_inr(typical)}.")
            else:
                notes.append(f"No priced hotels found in {dest} for those dates.")

        if kind in ("flights", "hotels", "plan_trip") and (flights or hotels):
            options.append("Share the booking links so the user can book; AURA does not book or pay on its own.")

        return AgentResult(agent=self.name, status="completed", insights=["\n".join(notes)] if notes else [],
                           constraints=constraints, options=options, data=data)

    async def _profile(self, user_id: str | None, as_of: pd.Timestamp) -> dict | None:
        if not user_id:
            return None
        try:
            events = await travel_history.get_events(user_id)
        except TravelHistoryError as exc:
            logger.warning("travel_history_unavailable", error=str(exc))
            return None
        if not events:
            return {"status": "no_history", "predictions": None, "history": {}, "activePlanning": None}
        try:
            return await asyncio.to_thread(get_predictor().predict, events, as_of)
        except Exception as exc:  # a bad model/feature input must not take the whole chat down
            logger.exception("travel_prediction_failed", error=str(exc))
            return None

    async def _intent(self, text: str, today: date) -> dict:
        try:
            out = await llm_service.chat_json([
                {"role": "system", "content": _INTENT_PROMPT.format(today=today, weekday=today.strftime("%A"))},
                {"role": "user", "content": text},
            ])
            return out if isinstance(out, dict) else _fallback_intent(text)
        except LLMServiceError as exc:
            logger.warning("travel_intent_llm_failed", error=str(exc))
            return _fallback_intent(text)


async def _safe(task, constraints: list[str], label: str):
    if task is None:
        return None
    try:
        return await task
    except travel_service.TravelServiceError as exc:
        constraints.append(f"{label} search unavailable: {exc}")
    except Exception as exc:  # network errors etc. must not take the whole reply down
        logger.warning("travel_search_failed", kind=label, error=str(exc))
        constraints.append(f"{label} search failed; try again shortly.")
    return None
