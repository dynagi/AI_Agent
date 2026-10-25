"""What AURA last pointed the user to (a flight's booking site, web search results, an official website), so that
"open it", "open the second one", "open the website you recommended earlier" or a "yes" to "Shall I open it?" opens
exactly that page. Kept in memory per user for a while; only https links are ever stored or opened."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

KEEP_S = 30 * 60          # "the website you recommended earlier" still works half an hour later
CONFIRM_S = 3 * 60        # a "yes" counts as "open it" only right after AURA asked


@dataclass
class Link:
    site: str             # shown and spoken name ("EaseMyTrip", "python.org")
    url: str
    label: str = ""       # what it is ("Air India AI 811", the page title)
    note: str = ""        # said after opening ("booking and payment are up to you")


_last: dict[str, tuple[float, list[Link]]] = {}
_asked: dict[str, float] = {}     # user -> when AURA asked "Shall I open it?"

_ORDINALS = {"first": 1, "1st": 1, "one": 1, "second": 2, "2nd": 2, "two": 2, "third": 3, "3rd": 3, "three": 3,
             "fourth": 4, "4th": 4, "fifth": 5, "5th": 5}
_OPEN_WORD = r"(?:open|go to|visit|take me to|show me)"
OPEN_IT = re.compile(
    rf"\b{_OPEN_WORD}\b.{{0,24}}\b(?:it|that|this|that one|this one|the site|the website|the link|the page|there)\b\s*[.!]?\s*$"
    rf"|\b{_OPEN_WORD}\b.{{0,40}}\b(?:you (?:recommended|suggested|found|mentioned)|earlier|last time|before)\b"
    r"|^\s*(?:book|open)(?: it| this| that| the site| the link)?\s*[.!]?\s*$", re.I)
ORDINAL = re.compile(rf"\b{_OPEN_WORD}\b.{{0,12}}\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\b"
                     r"(?:\s+(?:one|result|link|site|website|page|option))?", re.I)
YES = re.compile(r"^\s*(yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|open it|do it|haan|ha)\b", re.I)


_OPEN_VERB = re.compile(r"\b(open|book|go to|take me to|show me|visit)\b", re.I)
_OPEN_WHAT = re.compile(r"\b(it|that|this|site|website|link|page|booking)\b", re.I)
_NEW_REQUEST = re.compile(r"\bfrom\b.+\bto\b|\.(com|in|org|net|io)\b|\b(search|find|play|order)\b", re.I)


def _OPEN_LOOSE(message: str) -> bool:
    """Natural ways to say "open it" ("please open the website for me for this flight", "open it please"), as long
    as the sentence is short and isn't a new request of its own (seen while recording the demo: these went unheard)."""
    words = re.findall(r"[a-z']+", (message or "").lower())
    return (len(words) <= 12 and bool(_OPEN_VERB.search(message or "")) and bool(_OPEN_WHAT.search(message or ""))
            and not _NEW_REQUEST.search(message or ""))


def safe(url: str) -> bool:
    """Only https pages: no plain http, no app schemes, no direct downloads of programs or archives."""
    return bool(re.match(r"^https://[^\s/]+\.[^\s/]+", url or "")) and not re.search(
        r"\.(exe|msi|apk|dmg|pkg|bat|cmd|scr|zip|rar|7z|iso)(\?|#|$)", url, re.I)


def remember(user_id: str, links: list[Link], ask: bool = False) -> None:
    links = [link for link in links if safe(link.url)]
    if not links:
        return
    _last[user_id] = (time.time(), links)
    if ask:
        _asked[user_id] = time.time()
    else:
        _asked.pop(user_id, None)


def latest(user_id: str) -> list[Link]:
    at, links = _last.get(user_id, (0.0, []))
    return links if time.time() - at < KEEP_S else []


def forget(user_id: str) -> None:
    _last.pop(user_id, None)
    _asked.pop(user_id, None)


def open_request(message: str, user_id: str) -> tuple[str, str] | None:
    """(what to say, page to open) when the message asks to open what AURA last pointed to; None otherwise."""
    links = latest(user_id)
    if not links:
        if OPEN_IT.search(message) or ORDINAL.search(message):
            # nothing was suggested: ask, rather than letting the chat guess or the phone pick an app by sound
            return "I haven't pointed you to a website yet. Which site should I open?", ""
        return None
    pick = None
    m = ORDINAL.search(message)
    if m:
        n = _ORDINALS.get(m.group(1).lower(), 1)
        if n > len(links):
            return (f"I only have {len(links)} {'link' if len(links) == 1 else 'links'} from the last search. "
                    "Which one should I open?", "")
        pick = links[n - 1]
    elif OPEN_IT.search(message) or _OPEN_LOOSE(message) or (YES.match(message) and time.time() - _asked.get(user_id, 0) < CONFIRM_S):
        pick = links[0]
    if pick is None:
        return None
    _asked.pop(user_id, None)
    what = f" for {pick.label}" if pick.label else ""
    return f"Opening {pick.site}{what}.{(' ' + pick.note) if pick.note else ''}", pick.url
