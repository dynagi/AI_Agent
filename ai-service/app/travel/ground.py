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
        url = f"https://www.redbus.in/bus-tickets/{_slug(frm)}-to-{_slug(to)}"
        return Reply(site="redBus", url=url,
                     say=f"I can't see live bus fares, so I won't guess them. Opening redBus for buses from {frm} to {to}"
                         f"{on}: it shows operators, times, seats and prices. Booking and payment are up to you there.")
    if mode == "train":
        url = "https://www.google.com/search?q=" + quote_plus(f"trains from {frm} to {to}{on}")
        return Reply(site="Google trains", url=url,
                     say=f"I can't see live train availability, so I won't guess it. Opening the trains from {frm} to "
                         f"{to}{on} with their times; tickets are booked on IRCTC (or apps like ixigo and ConfirmTkt), "
                         "and booking and payment are up to you.")
    url = "https://www.google.com/search?q=" + quote_plus(f"shared cab from {frm} to {to}")
    return Reply(site="shared cab search", url=url,
                 say=f"Shared cabs run only on some routes, and I can't see their seats or fares. Opening a search for "
                     f"shared cabs from {frm} to {to}{on}, so you can see who serves this route.")
