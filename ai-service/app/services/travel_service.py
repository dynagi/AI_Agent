"""Travel search via SerpAPI's Google Flights and Google Hotels engines.

Amadeus's self-service developer portal was decommissioned (July 2026) —
its replacement, the Amadeus Enterprise API Portal, requires a business
agreement rather than a self-serve key. SerpAPI (already used for
Shopping) covers both flights and hotels with the same key, so it's the
realistic single integration here too."""
from __future__ import annotations

import httpx
from pydantic import BaseModel

from app.core.config import settings


class TravelServiceError(Exception):
    pass


class FlightOffer(BaseModel):
    price: float
    currency: str = "INR"
    origin: str
    destination: str
    departureAt: str
    arrivalAt: str
    airline: str | None = None
    flightNumber: str | None = None
    duration: int | None = None  # minutes
    stops: int = 0
    bookingUrl: str | None = None


class HotelOffer(BaseModel):
    name: str
    pricePerNight: float | None
    totalPrice: float | None
    currency: str = "INR"
    hotelClass: str | None = None
    rating: float | None = None
    link: str | None = None
    checkInDate: str
    checkOutDate: str


async def _serpapi_get(params: dict) -> dict:
    if not settings.serpapi_api_key:
        raise TravelServiceError("SERPAPI_API_KEY is not configured.")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            "https://serpapi.com/search", params={**params, "api_key": settings.serpapi_api_key}
        )
    if resp.status_code >= 400:
        raise TravelServiceError(f"SerpAPI request failed ({resp.status_code}): {resp.text}")
    return resp.json()


async def search_flights(
    origin: str, destination: str, departure_date: str, *, adults: int = 1, max_results: int = 15
) -> list[FlightOffer]:
    data = await _serpapi_get(
        {
            "engine": "google_flights",
            "departure_id": origin.upper(),
            "arrival_id": destination.upper(),
            "outbound_date": departure_date,
            "adults": adults,
            "type": 2,  # one-way
            "currency": settings.default_currency,
            "gl": settings.default_country,
            "hl": "en",
        }
    )

    raw_flights = [*data.get("best_flights", []), *data.get("other_flights", [])]
    results: list[FlightOffer] = []
    for entry in raw_flights[:max_results]:
        legs = entry.get("flights", [])
        if not legs:
            continue
        first, last = legs[0], legs[-1]
        results.append(
            FlightOffer(
                price=float(entry.get("price", 0) or 0),
                currency=settings.default_currency,
                origin=first.get("departure_airport", {}).get("id", origin.upper()),
                destination=last.get("arrival_airport", {}).get("id", destination.upper()),
                departureAt=first.get("departure_airport", {}).get("time", ""),
                arrivalAt=last.get("arrival_airport", {}).get("time", ""),
                airline=first.get("airline"),
                flightNumber=first.get("flight_number"),
                duration=entry.get("total_duration"),
                stops=len(legs) - 1,
                bookingUrl=data.get("search_metadata", {}).get("google_flights_url"),
            )
        )

    results.sort(key=lambda o: o.price)
    return results


async def search_hotels(
    destination: str, check_in: str, check_out: str, *, adults: int = 2, max_results: int = 15
) -> list[HotelOffer]:
    data = await _serpapi_get(
        {
            "engine": "google_hotels",
            "q": f"Hotels in {destination}",
            "check_in_date": check_in,
            "check_out_date": check_out,
            "adults": adults,
            "currency": settings.default_currency,
            "gl": settings.default_country,
            "hl": "en",
        }
    )

    results: list[HotelOffer] = []
    for entry in data.get("properties", [])[:max_results]:
        rate = entry.get("rate_per_night", {}) or {}
        total = entry.get("total_rate", {}) or {}
        results.append(
            HotelOffer(
                name=entry.get("name", "Unknown hotel"),
                pricePerNight=rate.get("extracted_lowest"),
                totalPrice=total.get("extracted_lowest"),
                currency=settings.default_currency,
                hotelClass=entry.get("hotel_class"),
                rating=entry.get("overall_rating"),
                link=entry.get("link"),
                checkInDate=check_in,
                checkOutDate=check_out,
            )
        )

    results.sort(key=lambda o: (o.totalPrice is None, o.totalPrice if o.totalPrice is not None else float("inf")))
    return results
