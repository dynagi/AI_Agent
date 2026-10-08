"""Short-term memory: the shopping conversation in progress.

Holds what is being ordered, the options that were shown and the question AURA is waiting on, so the next message
("Zepto", "the second one", "yes", "the cheaper one") is read as an answer to it. Kept in memory per user and
dropped after a while of silence; nothing here is long-term (that is preferences.py).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

TTL_SECONDS = 15 * 60


@dataclass
class Option:
    provider: str
    label: str                      # what the user sees/says: "Zepto"
    final_cost: float | None = None
    eta_minutes: int | None = None
    source: str = "not_checked"     # where the numbers came from
    observed: str | None = None
    kind: str = ""
    preferred: float = 0.0          # how strongly their history points here (0..1)
    score: float = 0.0

    def to_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class ShoppingSession:
    user_id: str
    items: list[dict] = field(default_factory=list)   # [{name, qty, item, known, hint?}]
    category: str = "other"
    options: list[Option] = field(default_factory=list)
    pending: str | None = None      # None | "choose_provider" | "confirm"
    provider: str | None = None     # selected provider
    criterion: str | None = None    # cheapest | fastest | usual | named
    question: str = ""
    reasons: list[str] = field(default_factory=list)
    updated: float = field(default_factory=time.time)

    def touch(self) -> None:
        self.updated = time.time()


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, ShoppingSession] = {}

    def get(self, user_id: str) -> ShoppingSession | None:
        s = self._sessions.get(user_id)
        if s and time.time() - s.updated > TTL_SECONDS:
            self._sessions.pop(user_id, None)
            return None
        return s

    def pending(self, user_id: str | None) -> bool:
        s = self.get(user_id) if user_id else None
        return bool(s and s.pending)

    def start(self, user_id: str) -> ShoppingSession:
        s = ShoppingSession(user_id=user_id)
        self._sessions[user_id] = s
        return s

    def clear(self, user_id: str) -> None:
        self._sessions.pop(user_id, None)


sessions = SessionStore()
