"""The flight conversation: "find me a flight to Chandigarh on the 31st".

1. Collects what is needed: where from, where to, which day (asks only for what is missing).
2. Asks about preferences: direct or not, time of day, travel time, airline, budget, what matters most. When AURA
   has learned the user's usual preferences it offers those instead ("same as last time?"), so the questions shrink
   as it learns.
3. Searches live (Google Flights), keeps only flights that meet the hard requirements, ranks the rest by fit, and
   reads the per-website prices of the recommended flight (and of the cheapest one, when they differ).
4. Explains the pick: what the extra rupees buy compared with the cheapest flight, which site sells it for least,
   baggage, and whether prices are high for that date.
5. Takes feedback ("too early", "I want direct", "under 12,000", "the second one") and learns from the choice.

It never books or pays: the user books on the site AURA names. Nothing here is guessed: unknown details are said to
be unknown.
"""
from __future__ import annotations

import asyncio

import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime

import structlog

from app.services.llm_service import LLMServiceError, llm_service
from app.services.travel_history import TravelHistoryError, travel_history
from app.services.travel_service import TravelServiceError
from app.travel import flights as live
from app.travel.preferences import (CHOICE_EVENT, PREF_EVENT, Fit, FlightPrefs, describe, eligible, hours, learned,
                                    part_of_day, score, why_better)

logger = structlog.get_logger()

FLIGHT_INTENT = re.compile(r"\b(flights?|fly|flying|airfare|plane tickets?|air tickets?|by air)\b", re.I)
SESSION_TTL_S = 15 * 60
PREF_FIELDS = ("time_of_day", "depart_after", "depart_before", "direct", "max_hours", "airline", "avoid_airline",
               "budget", "priority")
# every question ends with "?": that is what keeps the "Hey Aura" panel listening for the answer
PREFS_QUESTION = ("Before I search, a few quick things. Do you want a direct flight, a day or night departure, "
                  "any airline or budget, and what matters most: the lowest price, shorter travel time, or comfort? "
                  "Or do you have no preference?")


@dataclass
class Session:
    trip: dict = field(default_factory=lambda: {"adults": 1})
    prefs: FlightPrefs = field(default_factory=FlightPrefs)
    asked_prefs: bool = False
    offered: FlightPrefs | None = None          # learned preferences offered for confirmation
    question: str = ""
    stage: str = "collect"                      # collect | results
    result: live.SearchResult | None = None
    ranked: list[Fit] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    sites: dict[int, list[live.SiteOffer]] = field(default_factory=dict)
    touched: float = field(default_factory=time.time)


_sessions: dict[str, Session] = {}


def _session(user_id: str) -> Session | None:
    s = _sessions.get(user_id)
    if s and time.time() - s.touched > SESSION_TTL_S:
        _sessions.pop(user_id, None)
        return None
    return s


def reset(user_id: str) -> None:
    _sessions.pop(user_id, None)


# ---------------------------------------------------------------------------------- understanding a message
_READ = """You read one message from someone planning a flight with a voice assistant in India. Today is {today}.
Trip so far: {trip}. Preferences so far: {prefs}. The assistant last asked: "{question}".
Return JSON with exactly these keys, null when the message doesn't say it:
"relevant": true if the message is about this flight search (details, an answer, a change, a choice), false if it is about something else,
"origin_city", "origin_code": 3-letter IATA code of that city's main airport,
"destination_city", "destination_code",
"date": YYYY-MM-DD (resolve words like "next Friday" or "the 31st" from today),
"adults": number of travellers,
"time_of_day": "morning" | "afternoon" | "evening" | "night" | "day",
"depart_after": hour 0-23, "depart_before": hour 0-23,
"direct": true for direct only, false if stops are fine,
"max_hours": longest acceptable travel time in hours,
"airline": preferred airline, "avoid_airline": airline to avoid,
"budget": maximum price in rupees,
"priority": "price" | "time" | "comfort" | "convenience" | "balanced",
"no_preference": true if they say they have no preferences or anything is fine,
"choose": the number of the option they pick (1 = the one recommended) or null,
"wants_details": true if they ask for details or more options,
"confirm": true if they agree with what was asked ("yes", "same as last time"), false if they decline.
Use only what the user said; never invent a value."""

_ORDINAL = {"first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3}


def _rules(message: str) -> dict:
    """A small rule-based reading, used when the language model is unavailable."""
    t = message.lower()
    out: dict = {"relevant": bool(FLIGHT_INTENT.search(t))}
    if re.search(r"\b(direct|non[- ]?stop)\b", t):
        out["direct"] = True
    for word in ("morning", "afternoon", "evening", "night"):
        if re.search(rf"\b{word}\b", t):
            out["time_of_day"] = word
    m = re.search(r"(?:under|below|within|budget(?: of| is)?|max(?:imum)?)\s*(?:rs\.?|₹|inr)?\s*([\d,]+)\s*(k)?", t)
    if m:
        out["budget"] = float(m.group(1).replace(",", "")) * (1000 if m.group(2) else 1)
    if re.search(r"\b(cheap|cheapest|lowest price|low price)\b", t):
        out["priority"] = "price"
    elif re.search(r"\b(fast|fastest|shortest|quick)\b", t):
        out["priority"] = "time"
    elif re.search(r"\bcomfort", t):
        out["priority"] = "comfort"
    if re.search(r"\b(no preference|anything|any is fine|doesn't matter|don't care)\b", t):
        out["no_preference"] = True
    if re.fullmatch(r"\s*(yes|yeah|yep|sure|ok|okay|same|same as last time)\s*", t):
        out["confirm"] = True
    elif re.fullmatch(r"\s*(no|nope|nah)\s*", t):
        out["confirm"] = False
    m = re.search(r"\b(first|second|third|1st|2nd|3rd)\b|\boption (\d)\b|\bnumber (\d)\b", t)
    if m:
        out["choose"] = _ORDINAL.get(m.group(1) or "", 0) or int(m.group(2) or m.group(3))
    if re.search(r"\b(details|more options|show (?:me )?(?:all|more))\b", t):
        out["wants_details"] = True
    return out


async def read(message: str, s: Session) -> dict:
    prompt = _READ.format(today=f"{date.today().isoformat()} ({date.today():%A})", trip=s.trip,
                          prefs=s.prefs.known(), question=s.question or "nothing yet")
    try:
        out = await llm_service.chat_json([{"role": "system", "content": prompt},
                                           {"role": "user", "content": message}], max_tokens=500)
        return out if isinstance(out, dict) else _rules(message)
    except LLMServiceError as exc:
        logger.warning("flight_read_llm_failed", error=str(exc)[:160])
        return _rules(message)


def _code(value) -> str | None:
    v = str(value or "").strip().upper()
    return v if re.fullmatch(r"[A-Z]{3}", v) else None


def _date(value) -> str | None:
    try:
        d = datetime.strptime(str(value), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None
    return d.isoformat()


def _prefs_from(x: dict) -> FlightPrefs:
    vals = {}
    for k in PREF_FIELDS:
        v = x.get(k)
        if v in (None, "", "null"):
            continue
        if k in ("depart_after", "depart_before"):
            try:
                v = int(v)
            except (TypeError, ValueError):
                continue
            if not 0 <= v <= 23:
                continue
        elif k in ("max_hours", "budget"):
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if v <= 0:
                continue
        elif k == "direct":
            v = bool(v)
        elif k == "time_of_day" and v not in ("morning", "afternoon", "evening", "night", "day"):
            continue
        elif k == "priority" and v not in ("price", "time", "comfort", "convenience", "balanced"):
            continue
        vals[k] = v
    return FlightPrefs(**vals)


# ---------------------------------------------------------------------------------- talking
def _clock(stamp: str) -> str:
    try:
        return datetime.strptime(stamp, "%Y-%m-%d %H:%M").strftime("%I:%M %p").lstrip("0").lower()
    except (TypeError, ValueError):
        return stamp or "an unknown time"


def _day(iso: str) -> str:
    try:
        return datetime.strptime(iso, "%Y-%m-%d").strftime("%d %B").lstrip("0")
    except (TypeError, ValueError):
        return iso


def _stops(f: live.Flight) -> str:
    if f.stops == 0:
        return "direct"
    waits = ", ".join(f"{hours(l.minutes)} in {l.code or l.name}" for l in f.layovers)
    return f"{f.stops} stop{'s' if f.stops > 1 else ''} ({waits})" if waits else f"{f.stops} stops"


def _rupees(v: float | None) -> str:
    return "price unknown" if v is None else f"₹{v:,.0f}"


def _sites_line(sites: list[live.SiteOffer], f: live.Flight) -> str:
    if not sites:
        return f"{_rupees(f.price)} on Google Flights"
    best = sites[0]
    line = f"{_rupees(best.price)} on {best.site}"
    own = next((x for x in sites if x.is_airline), None)
    if own and own.site != best.site and own.price != best.price:
        line += f" (the airline's own site is {_rupees(own.price)})"
    return line


def _who(f: live.Flight) -> str:
    first = f.legs[0].flight_number if f.legs else ""
    return f"{f.airline} {first}".strip()


async def _sites(s: Session, f: live.Flight) -> list[live.SiteOffer]:
    if f.index not in s.sites:
        try:
            s.sites[f.index] = await live.site_prices(s.result, f)
        except TravelServiceError as exc:
            logger.warning("flight_sites_failed", error=str(exc)[:160])
            s.sites[f.index] = []
    return s.sites[f.index]


async def _recommend(s: Session) -> str:
    pool, s.notes = eligible(s.result.flights, s.prefs)
    s.ranked = score(pool, s.prefs)
    if not s.ranked:
        s.stage = "collect"
        return (f"I found no flights from {s.trip.get('origin_city') or s.result.origin} to "
                f"{s.trip.get('destination_city') or s.result.destination} on {_day(s.result.date)}. Want to try another day?")
    best = s.ranked[0].flight
    cheapest = min((f.flight for f in s.ranked), key=lambda f: f.price or 1e12)
    # both lookups at once: one after the other made the spoken answer miss the phone's time limit
    sites, _ = await asyncio.gather(_sites(s, best), _sites(s, cheapest))
    say = (f"For you I'd pick {_who(best)}: leaves {_clock(best.depart)}, lands {_clock(best.arrive)}, "
           f"{_stops(best)}, {hours(best.minutes)}, {_sites_line(sites, best)}.")
    overall = min((f for f in s.result.flights if f.price), key=lambda f: f.price, default=best)
    # what the pick really costs is its cheapest website, not the listed fare (seen on the phone: "the cheapest overall
    # is ₹9,976" right after quoting ₹9,800 for the pick)
    best_price = min([p for p in [best.price] + [x.price for x in sites] if p], default=best.price)
    if cheapest is best:
        if overall is best or (overall.price or 0) >= (best_price or 0):
            say += " It's also the cheapest flight."
        else:
            say += (f" It's the cheapest of the flights that fit; the cheapest overall is {_who(overall)} at "
                    f"{_rupees(overall.price)}, {_stops(overall)}, {hours(overall.minutes)}.")
    else:
        csites = await _sites(s, cheapest)
        c_price = csites[0].price if csites else cheapest.price
        b_price = sites[0].price if sites else best.price
        gains = why_better(best, cheapest, s.prefs)
        diff = (b_price or 0) - (c_price or 0)
        say += (f" It's {_rupees(diff)} more than the cheapest flight, {_who(cheapest)} at {_rupees(c_price)}, "
                + (f"but {gains}." if gains else "but it fits what you asked for better overall."))
    if s.notes:
        say += " " + " ".join(s.notes)
    r = s.result
    if r.price_level == "high" and r.typical_range:
        say += f" Prices are high for this date; it's usually {_rupees(r.typical_range[0])} to {_rupees(r.typical_range[1])}."
    elif r.price_level == "low":
        say += " Prices are lower than usual for this date."
    if s.trip.get("adults", 1) > 1:
        say += f" Prices are for all {s.trip['adults']} travellers."
    s.stage = "results"
    s.question = "Want the details and other options, or shall I note this one as your pick?"
    return f"{say} {s.question}"


async def _details(s: Session) -> str:
    lines = []
    for n, fit in enumerate(s.ranked[:3], start=1):
        f = fit.flight
        sites = await _sites(s, f) if n <= 2 else s.sites.get(f.index, [])
        bag = ", ".join(sites[0].baggage) if sites and sites[0].baggage else "baggage not listed"
        extra = f" {f.notes[0]}." if f.notes else ""
        lines.append(f"Option {n}: {f.airline} {f.flight_numbers}, {_clock(f.depart)} to {_clock(f.arrive)}, "
                     f"{hours(f.minutes)}, {_stops(f)}, {_sites_line(sites, f)}, {bag}.{extra}")
    s.question = "Which one would you like?"
    return " ".join(lines) + " Prices include taxes and fees as listed. " + s.question


async def _choose(s: Session, user_id: str, n: int) -> str:
    if not 1 <= n <= len(s.ranked):
        return f"I only have {len(s.ranked)} options. Which one would you like?"
    f = s.ranked[n - 1].flight
    sites = await _sites(s, f)
    await _remember(user_id, {"action": CHOICE_EVENT, "airline": f.airlines[0] if f.airlines else None,
                              "time_of_day": part_of_day(f.depart_hour), "stops": f.stops, "minutes": f.minutes,
                              "price": f.price, "route": f"{s.result.origin}-{s.result.destination}",
                              "was_cheapest": f.price == min(x.flight.price or 1e12 for x in s.ranked)})
    reset(user_id)
    where = (f"Book it on {sites[0].site} for {_rupees(sites[0].price)}"
             + (f"; {sites[1].site} has it for {_rupees(sites[1].price)}" if len(sites) > 1 else "")) if sites \
        else f"It's {_rupees(f.price)} on Google Flights"
    bag = f" Baggage: {', '.join(sites[0].baggage)}." if sites and sites[0].baggage else ""
    return (f"Noted: {f.airline} {f.flight_numbers} on {_day(s.result.date)}, {_clock(f.depart)} from {s.result.origin}. "
            f"{where}.{bag} I can't book or pay for it myself, so search this flight on that site to book it. "
            "I'll remember what you chose for next time.")


async def _remember(user_id: str, event: dict) -> None:
    if not user_id or user_id == "anonymous":
        return
    try:
        await travel_history.add_event(user_id, {"timestamp": datetime.now().isoformat(), **event})
    except (TravelHistoryError, Exception) as exc:   # learning must never break the conversation
        logger.warning("flight_learning_failed", error=str(exc)[:160])


async def _learned(user_id: str) -> FlightPrefs:
    if not user_id or user_id == "anonymous":
        return FlightPrefs()
    try:
        return learned(await travel_history.get_events(user_id))
    except Exception as exc:
        logger.warning("flight_profile_failed", error=str(exc)[:160])
        return FlightPrefs()


# ---------------------------------------------------------------------------------- the conversation
async def handle(message: str, user_id: str) -> str | None:
    """AURA's reply when the message is about flights (or answers a flight question); None when it isn't."""
    s = _session(user_id)
    if s is None:
        if not FLIGHT_INTENT.search(message):
            return None
        s = _sessions[user_id] = Session()
    s.touched = time.time()
    x = await read(message, s)
    # a short answer to AURA's own question ("direct, morning, cheapest") is the conversation going on, even when the
    # model calls it unrelated (seen on the phone: it went to the general chat instead)
    rules = _rules(message)
    answers = {k: v for k, v in rules.items() if k != "relevant" and v not in (None, "", False)}
    if answers:
        x = {**{k: v for k, v in rules.items() if k != "relevant"}, **{k: v for k, v in x.items() if v is not None}}
        x["relevant"] = True
    if x.get("relevant") is False and not FLIGHT_INTENT.search(message) and x.get("choose") is None:
        reset(user_id)                      # the user moved on to something else
        return None

    trip_before = (s.trip.get("origin"), s.trip.get("destination"), s.trip.get("date"))
    for k, key in (("origin_city", "origin_city"), ("destination_city", "destination_city")):
        if x.get(k):
            s.trip[key] = str(x[k])
    for k, key in (("origin_code", "origin"), ("destination_code", "destination")):
        if _code(x.get(k)):
            s.trip[key] = _code(x.get(k))
    if _date(x.get("date")):
        s.trip["date"] = _date(x["date"])
    if isinstance(x.get("adults"), (int, float)) and 1 <= int(x["adults"]) <= 9:
        s.trip["adults"] = int(x["adults"])
    said = _prefs_from(x)
    current = s.prefs.known()
    said = FlightPrefs(**{k: v for k, v in said.known().items() if current.get(k) != v})   # the model may echo old ones
    if said.known():
        s.prefs = s.prefs.merge(said)
        await _remember(user_id, {"action": PREF_EVENT, **said.known()})
    if s.offered is not None and x.get("confirm") is True:
        s.prefs = s.offered.merge(s.prefs)
    trip_changed = (s.trip.get("origin"), s.trip.get("destination"), s.trip.get("date")) != trip_before

    # ---- after showing flights: choose, details, or changes
    if s.stage == "results" and not trip_changed:
        if x.get("choose"):
            return await _choose(s, user_id, int(x["choose"]))
        if x.get("confirm") is True and "pick" in s.question:
            return await _choose(s, user_id, 1)
        if x.get("wants_details"):
            return await _details(s)
        if said.known():
            return await _recommend(s)       # same flights, re-ranked for the new preferences
        if x.get("confirm") is False:
            reset(user_id)
            return "Okay. Tell me if you want to look again."
        return f"Sorry, I didn't catch that. {s.question}"

    # ---- collecting the trip
    missing = [w for w, k in (("where you're flying from", "origin"), ("where to", "destination"),
                              ("which date", "date")) if not s.trip.get(k)]
    if missing:
        s.question = f"Sure. Can you tell me {' and '.join(missing)}?"
        return s.question
    if s.trip["date"] < date.today().isoformat():
        s.trip.pop("date")
        s.question = "That date has passed. Which date do you want to fly?"
        return s.question

    # ---- preferences: offer what was learned, or ask
    if not s.asked_prefs:
        s.asked_prefs = True
        usual = await _learned(user_id)
        if usual.known() and not s.prefs.known():
            s.offered = usual
            s.question = f"Last time you liked {describe(usual)}. Same again, or anything different?"
            return s.question
        if not s.prefs.known():
            s.question = PREFS_QUESTION
            return s.question

    # ---- search
    try:
        s.result = await live.search(s.trip["origin"], s.trip["destination"], s.trip["date"], s.trip.get("adults", 1))
    except TravelServiceError as exc:
        logger.warning("flight_search_failed", error=str(exc)[:200])
        reset(user_id)
        return "I couldn't reach the flight search right now, so I can't compare flights. Please try again in a bit."
    s.sites = {}
    return await _recommend(s)
