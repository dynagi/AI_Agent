"""Where a user's travel events (searches, views, bookings...) come from.

* Real users (Supabase auth uuid): `app_records` rows with collection="travel_events",
  read/written with the service-role key. The web app or backend logs events via POST /ai/travel/events.
* Demo users (USER_000123...): synthetic history bundled in data/demo_travel_events.csv, so the
  agent can be tried before anyone has real history. Disabled with TRAVEL_DEMO_ENABLED=false.
* Events logged for demo users, or when Supabase isn't configured, stay in memory until restart.
"""
from __future__ import annotations

import re
import uuid
from collections import defaultdict

import httpx
import pandas as pd

from app.core.config import settings

COLLECTION = "travel_events"
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class TravelHistoryError(Exception):
    pass


class TravelHistoryStore:
    def __init__(self) -> None:
        self._demo: dict[str, pd.DataFrame] | None = None
        self._memory: dict[str, list[dict]] = defaultdict(list)

    def _demo_events(self) -> dict[str, pd.DataFrame]:
        if self._demo is None:
            self._demo = {}
            if settings.travel_demo_enabled:
                df = pd.read_csv(settings.travel_demo_events)
                self._demo = {u: g.drop(columns="user_id").reset_index(drop=True) for u, g in df.groupby("user_id")}
        return self._demo

    def is_demo_user(self, user_id: str) -> bool:
        return user_id in self._demo_events()

    def _use_supabase(self, user_id: str) -> bool:
        return bool(settings.supabase_url and settings.supabase_service_role_key and _UUID_RE.match(user_id))

    def _headers(self) -> dict[str, str]:
        key = settings.supabase_service_role_key
        return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async def get_events(self, user_id: str) -> list[dict]:
        events: list[dict] = []
        demo = self._demo_events().get(user_id)
        if demo is not None:
            events += demo.to_dict("records")
        if self._use_supabase(user_id):
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{settings.supabase_url}/rest/v1/app_records",
                    headers=self._headers(),
                    params={"select": "data", "user_id": f"eq.{user_id}", "collection": f"eq.{COLLECTION}"},
                )
            if resp.status_code >= 400:
                raise TravelHistoryError(f"Supabase read failed ({resp.status_code}): {resp.text[:200]}")
            events += [r["data"] for r in resp.json()]
        events += self._memory.get(user_id, [])
        return events

    async def add_event(self, user_id: str, event: dict) -> str:
        """Stores one event; returns where it went ("supabase" or "memory")."""
        if self._use_supabase(user_id) and not self.is_demo_user(user_id):
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{settings.supabase_url}/rest/v1/app_records",
                    headers={**self._headers(), "Prefer": "return=minimal"},
                    json={"user_id": user_id, "collection": COLLECTION, "id": str(uuid.uuid4()), "data": event},
                )
            if resp.status_code >= 400:
                raise TravelHistoryError(f"Supabase write failed ({resp.status_code}): {resp.text[:200]}")
            return "supabase"
        self._memory[user_id].append(event)
        return "memory"

    def clear_memory(self, user_id: str) -> int:
        return len(self._memory.pop(user_id, []))


travel_history = TravelHistoryStore()
