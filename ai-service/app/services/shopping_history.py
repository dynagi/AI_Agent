"""Where a user's shopping events (searches, cart adds, orders, agent commands...) come from.

* Real users (Supabase auth uuid): `app_records` rows with collection="shopping_events",
  read/written with the service-role key.
* Demo users (USER_000123...): synthetic history bundled in data/demo_shopping_events.csv, so the
  model and agent can be tried before anyone has real history. Disabled with SHOPPING_DEMO_ENABLED=false.
* Events logged for demo users, or when Supabase isn't configured, stay in memory until restart.
"""
from __future__ import annotations

import re
import uuid
from collections import defaultdict

import httpx
import pandas as pd

from app.core.config import settings

COLLECTION = "shopping_events"
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_PAGE = 1000


class ShoppingHistoryError(Exception):
    pass


class ShoppingHistoryStore:
    def __init__(self) -> None:
        self._demo: dict[str, pd.DataFrame] | None = None
        self._memory: dict[str, list[dict]] = defaultdict(list)
        self._docs: dict[tuple[str, str, str], dict] = {}

    def _demo_events(self) -> dict[str, pd.DataFrame]:
        if self._demo is None:
            self._demo = {}
            if settings.shopping_demo_enabled:
                try:
                    df = pd.read_csv(settings.shopping_demo_events)
                except FileNotFoundError:
                    df = pd.DataFrame(columns=["user_id"])
                self._demo = {u: g.drop(columns="user_id").reset_index(drop=True) for u, g in df.groupby("user_id")}
        return self._demo

    def is_demo_user(self, user_id: str) -> bool:
        return user_id in self._demo_events()

    def _use_supabase(self, user_id: str | None = None) -> bool:
        configured = bool(settings.supabase_url and settings.supabase_service_role_key)
        return configured and (user_id is None or bool(_UUID_RE.match(user_id)))

    def _headers(self) -> dict[str, str]:
        key = settings.supabase_service_role_key
        return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async def get_events(self, user_id: str) -> list[dict]:
        events: list[dict] = []
        demo = self._demo_events().get(user_id)
        if demo is not None:
            events += demo.to_dict("records")
        if self._use_supabase(user_id):
            events += [r["data"] for r in await self._select({"user_id": f"eq.{user_id}", "select": "data"})]
        events += self._memory.get(user_id, [])
        return events

    async def real_users_events(self) -> dict[str, list[dict]]:
        """Every user with logged (non-synthetic) events: Supabase rows plus in-memory ones. Demo users that
        were given commands are included with their synthetic history, so their new events have context."""
        by_user: dict[str, list[dict]] = defaultdict(list)
        if self._use_supabase():
            for r in await self._select({"select": "user_id,data"}):
                by_user[r["user_id"]].append(r["data"])
        for uid, evs in self._memory.items():
            if evs and uid != "anonymous":  # requests without a signed-in user are not one person's history
                demo = self._demo_events().get(uid)
                if demo is not None and uid not in by_user:
                    by_user[uid] += demo.to_dict("records")
                by_user[uid] += evs
        return dict(by_user)

    async def _select(self, params: dict) -> list[dict]:
        rows: list[dict] = []
        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                resp = await client.get(
                    f"{settings.supabase_url}/rest/v1/app_records",
                    headers={**self._headers(), "Range": f"{len(rows)}-{len(rows) + _PAGE - 1}"},
                    params={"collection": f"eq.{COLLECTION}", **params},
                )
                if resp.status_code >= 400:
                    raise ShoppingHistoryError(f"Supabase read failed ({resp.status_code}): {resp.text[:200]}")
                page = resp.json()
                rows += page
                if len(page) < _PAGE:
                    return rows

    async def add_events(self, user_id: str, events: list[dict]) -> str:
        """Stores events; returns where they went ("supabase" or "memory")."""
        if not events:
            return "none"
        if self._use_supabase(user_id) and not self.is_demo_user(user_id):
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{settings.supabase_url}/rest/v1/app_records",
                    headers={**self._headers(), "Prefer": "return=minimal"},
                    json=[{"user_id": user_id, "collection": COLLECTION, "id": str(uuid.uuid4()), "data": e}
                          for e in events],
                )
            if resp.status_code >= 400:
                raise ShoppingHistoryError(f"Supabase write failed ({resp.status_code}): {resp.text[:200]}")
            return "supabase"
        self._memory[user_id] += events
        return "memory"

    # ---- single documents (the user's shopping rules) ----
    async def get_doc(self, user_id: str, collection: str, doc_id: str) -> dict | None:
        if self._use_supabase(user_id):
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    f"{settings.supabase_url}/rest/v1/app_records", headers=self._headers(),
                    params={"select": "data", "user_id": f"eq.{user_id}", "collection": f"eq.{collection}",
                            "id": f"eq.{doc_id}"})
            if resp.status_code >= 400:
                raise ShoppingHistoryError(f"Supabase read failed ({resp.status_code}): {resp.text[:200]}")
            rows = resp.json()
            return rows[0]["data"] if rows else None
        return self._docs.get((user_id, collection, doc_id))

    async def set_doc(self, user_id: str, collection: str, doc_id: str, data: dict) -> None:
        if self._use_supabase(user_id):
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{settings.supabase_url}/rest/v1/app_records",
                    headers={**self._headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
                    params={"on_conflict": "user_id,collection,id"},
                    json={"user_id": user_id, "collection": collection, "id": doc_id, "data": data})
            if resp.status_code >= 400:
                raise ShoppingHistoryError(f"Supabase write failed ({resp.status_code}): {resp.text[:200]}")
            return
        self._docs[(user_id, collection, doc_id)] = data

    def clear_memory(self, user_id: str) -> int:
        return len(self._memory.pop(user_id, []))


shopping_history = ShoppingHistoryStore()
