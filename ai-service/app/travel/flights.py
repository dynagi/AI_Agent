"""Live flight data for the assistant: every flight on a route and date with its full details, and, for one chosen
flight, the price each booking website charges for it (with baggage).

Source: SerpAPI's Google Flights engine. Fields read here were checked against real responses; anything Google
Flights doesn't report is left as None, never filled in. Each call costs one SerpAPI search (the free plan has
about 100 a month), so the assistant asks for booking prices only for the flights it is about to recommend.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.core.config import settings
from app.services import travel_service


@dataclass
class Leg:
    airline: str
    flight_number: str
    from_code: str
    from_name: str
    to_code: str
    to_name: str
    depart: str          # "2026-10-31 16:10" (local time at the airport)
    arrive: str
    minutes: int | None
    aircraft: str | None = None
    legroom: str | None = None
    overnight: bool = False


@dataclass
class Layover:
    code: str
    name: str
    minutes: int | None
    overnight: bool = False


@dataclass
class Flight:
    index: int
    price: float | None           # total for the passengers searched, as Google Flights lists it
    minutes: int | None
    legs: list[Leg]
    layovers: list[Layover]
    booking_token: str | None
    notes: list[str] = field(default_factory=list)   # Google Flights' own notes ("Below average legroom", ...)

    @property
    def stops(self) -> int:
        return max(0, len(self.legs) - 1)

    @property
    def airlines(self) -> list[str]:
        return list(dict.fromkeys(l.airline for l in self.legs if l.airline))

    @property
    def airline(self) -> str:
        return " + ".join(self.airlines) or "Unknown airline"

    @property
    def flight_numbers(self) -> str:
        return ", ".join(l.flight_number for l in self.legs if l.flight_number)

    @property
    def depart(self) -> str:
        return self.legs[0].depart if self.legs else ""

    @property
    def arrive(self) -> str:
        return self.legs[-1].arrive if self.legs else ""

    @property
    def depart_hour(self) -> int | None:
        return _hour(self.depart)

    @property
    def overnight(self) -> bool:
        return any(l.overnight for l in self.legs) or any(lo.overnight for lo in self.layovers)


@dataclass
class SiteOffer:
    site: str                       # the website or airline selling it ("EaseMyTrip", "IndiGo")
    price: float
    baggage: list[str] = field(default_factory=list)
    is_airline: bool = False


@dataclass
class SearchResult:
    origin: str
    destination: str
    date: str
    adults: int
    flights: list[Flight]
    lowest_price: float | None = None
    price_level: str | None = None              # "low" | "typical" | "high", Google Flights' own judgement
    typical_range: tuple[float, float] | None = None
    google_flights_url: str | None = None


def _hour(stamp: str) -> int | None:
    try:
        return datetime.strptime(stamp, "%Y-%m-%d %H:%M").hour
    except (TypeError, ValueError):
        return None


def _params(origin: str, destination: str, date: str, adults: int) -> dict:
    return {
        "engine": "google_flights", "departure_id": origin.upper(), "arrival_id": destination.upper(),
        "outbound_date": date, "adults": adults, "type": 2,   # one way
        "currency": settings.default_currency, "gl": settings.default_country, "hl": "en",
    }


def parse_flights(data: dict) -> list[Flight]:
    out: list[Flight] = []
    for i, entry in enumerate([*data.get("best_flights", []), *data.get("other_flights", [])]):
        legs = []
        for leg in entry.get("flights") or []:
            dep, arr = leg.get("departure_airport") or {}, leg.get("arrival_airport") or {}
            legs.append(Leg(airline=leg.get("airline") or "", flight_number=leg.get("flight_number") or "",
                            from_code=dep.get("id") or "", from_name=dep.get("name") or "",
                            to_code=arr.get("id") or "", to_name=arr.get("name") or "",
                            depart=dep.get("time") or "", arrive=arr.get("time") or "",
                            minutes=leg.get("duration"), aircraft=leg.get("airplane"), legroom=leg.get("legroom"),
                            overnight=bool(leg.get("overnight"))))
        if not legs:
            continue
        layovers = [Layover(code=l.get("id") or "", name=l.get("name") or "", minutes=l.get("duration"),
                            overnight=bool(l.get("overnight"))) for l in entry.get("layovers") or []]
        notes = [n for leg in entry.get("flights") or [] for n in (leg.get("extensions") or [])
                 if "carbon" not in str(n).lower()]
        price = entry.get("price")
        out.append(Flight(index=i, price=float(price) if price is not None else None, minutes=entry.get("total_duration"),
                          legs=legs, layovers=layovers, booking_token=entry.get("booking_token"),
                          notes=list(dict.fromkeys(notes))))
    return out


async def search(origin: str, destination: str, date: str, adults: int = 1) -> SearchResult:
    data = await travel_service._serpapi_get(_params(origin, destination, date, adults))
    insights = data.get("price_insights") or {}
    typical = insights.get("typical_price_range")
    return SearchResult(
        origin=origin.upper(), destination=destination.upper(), date=date, adults=adults,
        flights=parse_flights(data), lowest_price=insights.get("lowest_price"), price_level=insights.get("price_level"),
        typical_range=(float(typical[0]), float(typical[1])) if isinstance(typical, list) and len(typical) == 2 else None,
        google_flights_url=(data.get("search_metadata") or {}).get("google_flights_url"))


def parse_sites(data: dict, airlines: list[str]) -> list[SiteOffer]:
    sites: dict[str, SiteOffer] = {}
    own = {a.lower() for a in airlines}
    for option in data.get("booking_options") or []:
        o = option.get("together") or option        # one-way options are flat or under "together"
        name, price = o.get("book_with"), o.get("price")
        if not name or price is None:
            continue
        offer = SiteOffer(site=name, price=float(price), baggage=list(o.get("baggage_prices") or []),
                          is_airline=name.lower() in own)
        if name not in sites or offer.price < sites[name].price:
            sites[name] = offer
    return sorted(sites.values(), key=lambda s: s.price)


async def site_prices(result: SearchResult, flight: Flight) -> list[SiteOffer]:
    """What each booking website charges for exactly this flight, cheapest first. Empty if Google Flights gave no
    booking options."""
    if not flight.booking_token:
        return []
    data = await travel_service._serpapi_get({**_params(result.origin, result.destination, result.date, result.adults),
                                              "booking_token": flight.booking_token})
    return parse_sites(data, flight.airlines)
