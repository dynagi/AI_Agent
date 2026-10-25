"""Trains, buses and shared cabs: there is no free live-fare source for these in India (IRCTC, redBus and the cab
apps have no public API), so AURA never quotes a fare or a time for them. It names where to look and opens that page
on the phone with the route filled in where the site allows it."""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import quote_plus

_MODE = re.compile(r"\b(trains?|rail(?:way)?|bus(?:es)?|shared (?:cab|taxi|ride)s?|cab ?shar(?:e|ing)|share (?:a )?(?:cab|taxi)|"
                   r"car ?pool(?:ing)?|ride ?shar(?:e|ing))\b", re.I)
_ROUTE = re.compile(r"\bfrom\s+([a-z][a-z .]{1,30}?)\s+to\s+([a-z][a-z .]{1,30}?)(?=\s+(?:on|for|tomorrow|today|this|next|by|at)\b|[,.?!]|$)",
                    re.I)
_TO_FROM = re.compile(r"\bto\s+([a-z][a-z .]{1,30}?)\s+from\s+([a-z][a-z .]{1,30}?)(?=\s+(?:on|for|tomorrow|today|this|next|by|at)\b|[,.?!]|$)",
                      re.I)
_WHEN = re.compile(r"\b(today|tomorrow|day after tomorrow|(?:this|next) \w+|on [\w ]{3,20}?)(?=[,.?!]|$)", re.I)


@dataclass
class Reply:
    say: str
    url: str
    site: str


def mode_of(text: str) -> str | None:
    m = _MODE.search(text or "")
    if not m:
        return None
    w = m.group(1).lower()
    if w.startswith(("train", "rail")):
        return "train"
    if w.startswith("bus"):
        return "bus"
    return "shared cab"


def _route(text: str) -> tuple[str, str] | None:
    m = _ROUTE.search(text)
    if m:
        return m.group(1).strip(" ."), m.group(2).strip(" .")
    m = _TO_FROM.search(text)
    if m:
        return m.group(2).strip(" ."), m.group(1).strip(" .")
    return None


# main railway station codes, for opening train results on ixigo with the route already filled in
STATIONS = {
    "mumbai": "CSMT", "bombay": "CSMT", "delhi": "NDLS", "new delhi": "NDLS", "bangalore": "SBC", "bengaluru": "SBC",
    "chennai": "MAS", "madras": "MAS", "kolkata": "HWH", "calcutta": "HWH", "hyderabad": "SC", "secunderabad": "SC",
    "pune": "PUNE", "ahmedabad": "ADI", "jaipur": "JP", "lucknow": "LKO", "kanpur": "CNB", "nagpur": "NGP",
    "indore": "INDB", "bhopal": "BPL", "patna": "PNBE", "varanasi": "BSB", "agra": "AGC", "surat": "ST",
    "vadodara": "BRC", "goa": "MAO", "madgaon": "MAO", "kochi": "ERS", "ernakulam": "ERS", "trivandrum": "TVC",
    "thiruvananthapuram": "TVC", "coimbatore": "CBE", "madurai": "MDU", "mysore": "MYS", "mysuru": "MYS",
    "mangalore": "MAQ", "visakhapatnam": "VSKP", "vizag": "VSKP", "vijayawada": "BZA", "bhubaneswar": "BBS",
    "guwahati": "GHY", "chandigarh": "CDG", "amritsar": "ASR", "jammu": "JAT", "dehradun": "DDN", "haridwar": "HW",
    "jodhpur": "JU", "udaipur": "UDZ", "ajmer": "AII", "gwalior": "GWL", "raipur": "R", "ranchi": "RNC",
    "nashik": "NK", "aurangabad": "AWB", "kota": "KOTA", "allahabad": "PRYJ", "prayagraj": "PRYJ", "gorakhpur": "GKP",
    "tirupati": "TPTY", "hubli": "UBL", "belgaum": "BGM", "shimla": "SML", "jalandhar": "JUC", "ludhiana": "LDH",
}
_MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                       "september", "october", "november", "december"], 1)}
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def travel_date(text: str, today=None):
    """The date the user asked for ("tomorrow", "on 30th October", "on Friday"); today when none is said."""
    from datetime import date, timedelta
    today = today or date.today()
    t = (text or "").lower()
    if "day after tomorrow" in t:
        return today + timedelta(days=2)
    if "tomorrow" in t:
        return today + timedelta(days=1)
    m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(" + "|".join(_MONTHS) + r"|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b", t) \
        or re.search(r"\b(" + "|".join(_MONTHS) + r"|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b", t)
    if m:
        a, b = m.group(1), m.group(2)
        day, mon = (int(a), b) if a.isdigit() else (int(b), a)
        month = next(v for k, v in _MONTHS.items() if k.startswith(mon[:3]))
        try:
            d = date(today.year, month, day)
        except ValueError:
            return today
        return d if d >= today else date(today.year + 1, month, day)
    for i, name in enumerate(_WEEKDAYS):
        if re.search(rf"\b{name}\b", t):
            return today + timedelta(days=(i - today.weekday()) % 7 or 7)
    return today


def _station(city: str) -> str | None:
    return STATIONS.get(city.lower().strip())


def _slug(city: str) -> str:
    return re.sub(r"[^a-z]+", "-", city.lower()).strip("-")


def handle(text: str) -> Reply | str | None:
    """A reply (with the page to open) for a train / bus / shared cab question; a question back when the route is
    missing; None when the message isn't about these."""
    mode = mode_of(text)
    if mode is None:
        return None
    route = _route(text)
    if route is None:
        return f"Sure. Which {mode} route: from which city to which city?"
    frm, to = (c.title() for c in route)
    when = _WHEN.search(text)
    on = f" {when.group(1)}" if when else ""
    if mode == "bus":
        day = travel_date(text)
        # with the date: redBus opens on the day asked for (seen: without it, it opened on today, not "tomorrow")
        url = f"https://www.redbus.in/bus-tickets/{_slug(frm)}-to-{_slug(to)}?onward={day.strftime('%d-%b-%Y')}"
        return Reply(site="redBus", url=url,
                     say=f"I can't see live bus fares, so I won't guess them. Opening redBus for buses from {frm} to {to}"
                         f"{on}: it shows operators, times, seats and prices. Booking and payment are up to you there.")
    if mode == "train":
        day = travel_date(text)
        src, dst = _station(frm), _station(to)
        if src and dst:
            # ixigo's results for the route and date: real trains with seat availability and fares (checked)
            url = f"https://www.ixigo.com/search/result/train/{src}/{dst}/{day.strftime('%d%m%Y')}//1/0/0/0/ALL"
            return Reply(site="ixigo", url=url,
                         say=f"Opening ixigo with trains from {frm} to {to} on {day.strftime('%d %B').lstrip('0')}: "
                             "it shows every train with seats and fares. Booking and payment are up to you there.")
        url = "https://www.google.com/search?q=" + quote_plus(f"trains from {frm} to {to}{on}")
        return Reply(site="Google trains", url=url,
                     say=f"I don't know the station for {frm if not src else to}, so I'm opening a search for trains from "
                         f"{frm} to {to}{on}. Booking and payment are up to you.")
    url = "https://www.google.com/search?q=" + quote_plus(f"shared cab from {frm} to {to}")
    return Reply(site="shared cab search", url=url,
                 say=f"Shared cabs run only on some routes, and I can't see their seats or fares. Opening a search for "
                     f"shared cabs from {frm} to {to}{on}, so you can see who serves this route.")
