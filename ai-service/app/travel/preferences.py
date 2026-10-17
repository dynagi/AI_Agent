"""What the user wants from a flight, how well each flight fits it, and what AURA has learned from earlier trips.

The recommendation is the best fit, not the cheapest: a flight costs a little more when it is direct, shorter, or at
the time the user wants, and the explanation says exactly what the extra money buys.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field

from app.travel.flights import Flight

PRIORITIES = ("price", "time", "comfort", "convenience", "balanced")
TIMES = {   # departure hours (local) for each part of the day
    "morning": range(5, 12), "afternoon": range(12, 17), "evening": range(17, 22),
    "night": [22, 23, 0, 1, 2, 3, 4], "day": range(6, 18),
}


@dataclass
class FlightPrefs:
    time_of_day: str | None = None          # morning | afternoon | evening | night | day
    depart_after: int | None = None         # hour, 0-23
    depart_before: int | None = None
    direct: bool | None = None              # True: direct only; False: connections are fine
    max_hours: float | None = None
    airline: str | None = None
    avoid_airline: str | None = None
    budget: float | None = None
    priority: str | None = None             # price | time | comfort | convenience | balanced

    def known(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}

    def merge(self, other: "FlightPrefs") -> "FlightPrefs":
        mine = asdict(self)
        mine.update(other.known())
        return FlightPrefs(**mine)


# ---------------------------------------------------------------------------------- fit
WEIGHTS = {   # price, travel time, stops, timing, comfort
    "price": (0.75, 0.08, 0.08, 0.06, 0.03),   # "price matters most" means it: only a much worse trip loses
    "time": (0.15, 0.45, 0.25, 0.10, 0.05),
    "comfort": (0.15, 0.15, 0.30, 0.15, 0.25),
    "convenience": (0.15, 0.15, 0.25, 0.40, 0.05),
    "balanced": (0.30, 0.25, 0.20, 0.15, 0.10),
}


def in_window(hour: int | None, prefs: FlightPrefs) -> bool | None:
    """Whether a departure hour matches the preferred time; None when there is no time preference."""
    if hour is None:
        return None
    checks = []
    if prefs.time_of_day in TIMES:
        checks.append(hour in TIMES[prefs.time_of_day])
    if prefs.depart_after is not None:
        checks.append(hour >= prefs.depart_after)
    if prefs.depart_before is not None:
        checks.append(hour < prefs.depart_before)
    return all(checks) if checks else None


@dataclass
class Fit:
    flight: Flight
    score: float
    reasons: list[str] = field(default_factory=list)


def eligible(flights: list[Flight], prefs: FlightPrefs) -> tuple[list[Flight], list[str]]:
    """Applies the hard requirements (direct only, longest acceptable trip, budget, airline to avoid). A requirement
    that no flight meets is relaxed rather than leaving nothing, and the note says so."""
    pool = [f for f in flights if f.price is not None]
    notes = []
    for label, keep in (
        ("direct", lambda f: f.stops == 0 if prefs.direct else True),
        ("duration", lambda f: prefs.max_hours is None or (f.minutes or 0) <= prefs.max_hours * 60),
        ("budget", lambda f: prefs.budget is None or (f.price or 0) <= prefs.budget),
        ("avoid", lambda f: not prefs.avoid_airline or prefs.avoid_airline.lower() not in f.airline.lower()),
    ):
        kept = [f for f in pool if keep(f)]
        if kept:
            pool = kept
        elif pool:
            notes.append(_relaxed(label, prefs))
    return pool, notes


def _relaxed(label: str, prefs: FlightPrefs) -> str:
    if label == "direct":
        return "There's no direct flight that day, so these include a stop."
    if label == "duration":
        return f"No flight is under {prefs.max_hours:g} hours, so I've included longer ones."
    if label == "budget":
        return f"Nothing is within ₹{prefs.budget:,.0f}; these are the closest."
    return f"Only {prefs.avoid_airline} flies this, so it's included."


def score(flights: list[Flight], prefs: FlightPrefs) -> list[Fit]:
    if not flights:
        return []
    w_price, w_time, w_stops, w_timing, w_comfort = WEIGHTS.get(prefs.priority or "balanced", WEIGHTS["balanced"])
    cheapest = min(f.price for f in flights if f.price)
    fastest = min((f.minutes for f in flights if f.minutes), default=None)
    fits = []
    for f in flights:
        price = (cheapest / f.price) ** 2 if f.price else 0   # squared: a 10% dearer flight scores 0.83, not 0.91
        time = fastest / f.minutes if fastest and f.minutes else 0.5
        stops = {0: 1.0, 1: 0.55}.get(f.stops, 0.25)
        match = in_window(f.depart_hour, prefs)
        red_eye = f.depart_hour is not None and f.depart_hour < 5
        timing = 1.0 if match else 0.3 if match is False else (0.6 if red_eye or f.overnight else 0.9)
        long_wait = any((l.minutes or 0) > 180 for l in f.layovers)
        comfort = 0.7 - (0.3 if long_wait else 0) - (0.2 if f.overnight else 0)
        comfort += 0.2 if any("above average legroom" in n.lower() for n in f.notes) else 0
        comfort -= 0.15 if any("below average legroom" in n.lower() for n in f.notes) else 0
        total = w_price * price + w_time * time + w_stops * stops + w_timing * timing + w_comfort * max(0, comfort)
        if prefs.airline and prefs.airline.lower() in f.airline.lower():
            total += 0.12
        fits.append(Fit(flight=f, score=round(total, 4)))
    return sorted(fits, key=lambda x: (-x.score, x.flight.price or 0))


def hours(minutes: int | None) -> str:
    if not minutes:
        return "unknown time"
    h, m = divmod(int(minutes), 60)
    return f"{h} h {m} min" if m else f"{h} h"


def why_better(best: Flight, cheapest: Flight, prefs: FlightPrefs) -> str:
    """What the recommended flight gives for its extra cost compared with the cheapest one."""
    gains = []
    if best.stops < cheapest.stops:
        gains.append("direct" if best.stops == 0 else f"{best.stops} stop instead of {cheapest.stops}")
    if best.minutes and cheapest.minutes and cheapest.minutes - best.minutes >= 45:
        gains.append(f"{hours(cheapest.minutes - best.minutes)} shorter")
    b, c = in_window(best.depart_hour, prefs), in_window(cheapest.depart_hour, prefs)
    if b and not c:
        gains.append("leaves at the time you wanted")
    if prefs.airline and prefs.airline.lower() in best.airline.lower() and prefs.airline.lower() not in cheapest.airline.lower():
        gains.append(f"on {prefs.airline}")
    if cheapest.overnight and not best.overnight:
        gains.append("no overnight travel")
    if any((l.minutes or 0) > 180 for l in cheapest.layovers) and not any((l.minutes or 0) > 180 for l in best.layovers):
        gains.append("no long wait between flights")
    return ", ".join(gains)


# ---------------------------------------------------------------------------------- learning
PREF_EVENT = "flight_pref"
CHOICE_EVENT = "flight_choice"


def part_of_day(hour: int | None) -> str | None:
    if hour is None:
        return None
    for name in ("morning", "afternoon", "evening", "night"):
        if hour in TIMES[name]:
            return name
    return None


def learned(events: list[dict]) -> FlightPrefs:
    """Preferences that showed up repeatedly: a stated preference counts twice, a chosen flight once. A value needs
    a weight of 2 and a clear majority to be learned; anything less is left for AURA to ask about."""
    votes: dict[str, Counter] = {k: Counter() for k in ("time_of_day", "direct", "airline", "priority")}
    for e in events:
        if e.get("action") == PREF_EVENT:
            for k in votes:
                if e.get(k) is not None:
                    votes[k][e[k]] += 2
        elif e.get("action") == CHOICE_EVENT:
            if e.get("time_of_day"):
                votes["time_of_day"][e["time_of_day"]] += 1
            if e.get("stops") is not None:
                votes["direct"][e["stops"] == 0] += 1
            if e.get("airline"):
                votes["airline"][e["airline"]] += 1
    out = {}
    for k, c in votes.items():
        if not c:
            continue
        value, weight = c.most_common(1)[0]
        if weight >= 2 and weight / sum(c.values()) >= 0.6:
            out[k] = value
    return FlightPrefs(**out)


def describe(prefs: FlightPrefs) -> str:
    """Preferences in words ("direct, morning flights, shortest travel time")."""
    bits = []
    if prefs.direct:
        bits.append("direct")
    if prefs.time_of_day:
        bits.append(f"{prefs.time_of_day}")
    text = (" ".join(bits) + " flights") if bits else ""
    more = []
    if prefs.airline:
        more.append(f"on {prefs.airline}")
    if prefs.priority and prefs.priority != "balanced":
        more.append({"price": "lowest price first", "time": "shortest travel time", "comfort": "comfort first",
                     "convenience": "the most convenient timing"}[prefs.priority])
    return ", ".join([p for p in [text] + more if p])
