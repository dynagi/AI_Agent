"""Per-domain interest scoring, trained daily on the user's own
interested / not-interested feedback (stored client-side as a
"<domain>Feedback" record collection, synced through Supabase).

Two domains today: "shopping" (products) and "travel" (flights + hotels).
Each gets its own model file and feedback collection, but shares the same
generic engine below — a candidate is just price/rating/reviews plus a
handful of free-text fields (name, provider, category), which covers a
product, a flight, or a hotel equally well.

There is no pretrained model to lean on for shopping: the transformer
regressor in this repo was trained (in AI_AGENT.ipynb) to predict a
*purchase amount* from a fixed 5656-dim feature encoding, and the fitted
scaler/encoder that produced that encoding weren't saved alongside the
model, so it can't be reloaded correctly. Rather than feed it mismatched
vectors, we train a small, fully-owned interest classifier from scratch on
real feedback, and retrain it every day as more feedback arrives — for
every domain, not just shopping.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
from pathlib import Path
from typing import Any, Literal

import httpx
import numpy as np
import structlog
from sklearn.linear_model import LogisticRegression

from app.core.config import settings

logger = structlog.get_logger()

Domain = Literal["shopping", "travel"]

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

FEEDBACK_COLLECTION: dict[Domain, str] = {
    "shopping": "shoppingFeedback",
    "travel": "travelFeedback",
}
MODEL_PATH: dict[Domain, Path] = {
    "shopping": DATA_DIR / "interest_model_shopping.joblib",
    "travel": DATA_DIR / "interest_model_travel.joblib",
}
META_PATH: dict[Domain, Path] = {
    "shopping": DATA_DIR / "interest_model_shopping_meta.json",
    "travel": DATA_DIR / "interest_model_travel_meta.json",
}

HASH_BUCKETS = 24  # text (provider/category/name tokens) -> fixed-size hashed features
MIN_TRAINING_SAMPLES = 6

# Module-level cache so we don't hit disk on every /suggestions call. Keyed by domain.
_model_cache: dict[Domain, tuple[float, Any]] = {}


class RecommendationError(Exception):
    pass


def _text_hash_features(*texts: str | None) -> np.ndarray:
    """Cheap, dependency-free hashing trick: stable across process restarts
    (unlike Python's randomized `hash()`), so a model trained today still
    scores the same candidate the same way tomorrow."""
    vec = np.zeros(HASH_BUCKETS, dtype=np.float32)
    for text in texts:
        if not text:
            continue
        for token in str(text).lower().split():
            digest = hashlib.md5(token.encode("utf-8")).hexdigest()
            vec[int(digest, 16) % HASH_BUCKETS] += 1.0
    return vec


def featurize(item: dict) -> np.ndarray:
    """A candidate (product, flight, or hotel) -> fixed-size numeric feature
    vector. Works for both feedback rows (past) and live search results
    (present) as long as both carry the same fields: name/title, price,
    rating, reviews, provider/source/airline, category/mode."""
    price = item.get("price")
    price = float(price) if isinstance(price, (int, float)) and price > 0 else 0.0

    rating = item.get("rating")
    rating = float(rating) if isinstance(rating, (int, float)) else 3.5

    reviews = item.get("reviews")
    reviews = float(reviews) if isinstance(reviews, (int, float)) and reviews >= 0 else 0.0

    numeric = np.array([math.log1p(price), rating, math.log1p(reviews)], dtype=np.float32)

    text = _text_hash_features(
        item.get("provider") or item.get("source") or item.get("airline"),
        item.get("category") or item.get("mode"),
        item.get("name") or item.get("title"),
    )

    return np.concatenate([numeric, text])


def _supabase_headers() -> dict[str, str]:
    return {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
    }


async def _fetch_feedback(domain: Domain) -> list[dict]:
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise RecommendationError("Supabase is not configured.")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{settings.supabase_url}/rest/v1/app_records",
            headers=_supabase_headers(),
            params={"collection": f"eq.{FEEDBACK_COLLECTION[domain]}", "select": "data"},
        )
    if resp.status_code >= 400:
        raise RecommendationError(f"Supabase feedback query failed ({resp.status_code}): {resp.text}")

    rows = resp.json()
    return [row["data"] for row in rows if isinstance(row.get("data"), dict)]


def _load_model(domain: Domain):
    path = MODEL_PATH[domain]
    if not path.exists():
        return None
    mtime = path.stat().st_mtime
    cached = _model_cache.get(domain)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    import joblib

    model = joblib.load(path)
    _model_cache[domain] = (mtime, model)
    return model


def _heuristic_score(item: dict) -> float:
    """Used until enough feedback exists to train a real model."""
    rating = item.get("rating")
    rating = float(rating) if isinstance(rating, (int, float)) else 3.5
    reviews = item.get("reviews")
    reviews = float(reviews) if isinstance(reviews, (int, float)) and reviews >= 0 else 0.0
    return round(min(1.0, (rating / 5.0) * 0.7 + min(math.log1p(reviews) / 10.0, 0.3)), 4)


def suggest(items: list[dict], domain: Domain = "shopping") -> list[dict]:
    model = _load_model(domain)
    ranked: list[dict] = []
    for item in items:
        if model is not None:
            score = float(model.predict_proba(featurize(item).reshape(1, -1))[0][1])
        else:
            score = _heuristic_score(item)
        ranked.append({**item, "interestScore": round(score, 4)})
    ranked.sort(key=lambda p: p["interestScore"], reverse=True)
    return ranked


async def train_model(domain: Domain = "shopping") -> dict:
    """Retrains the interest classifier for one domain from every feedback
    row seen so far. Safe to call as often as you like (idempotent,
    cumulative); the daily scheduler in main.py is what turns "train every
    day" into reality, for both domains."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    feedback = await _fetch_feedback(domain)
    labeled = [f for f in feedback if isinstance(f.get("interested"), bool)]

    labels = {f["interested"] for f in labeled}
    if len(labeled) < MIN_TRAINING_SAMPLES or len(labels) < 2:
        meta = {
            "domain": domain,
            "status": "skipped",
            "reason": "not enough labeled feedback yet (need both interested and not-interested examples)",
            "samples": len(labeled),
            "trained_at": None,
        }
        META_PATH[domain].write_text(json.dumps(meta, indent=2))
        logger.info("interest_model.train.skipped", **meta)
        return meta

    X = np.stack([featurize(f) for f in labeled])
    y = np.array([1 if f["interested"] else 0 for f in labeled], dtype=np.int32)

    model = LogisticRegression(max_iter=500, class_weight="balanced")
    model.fit(X, y)

    import joblib

    joblib.dump(model, MODEL_PATH[domain])

    meta = {
        "domain": domain,
        "status": "trained",
        "samples": len(labeled),
        "positive": int(y.sum()),
        "negative": int(len(y) - y.sum()),
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    META_PATH[domain].write_text(json.dumps(meta, indent=2))
    logger.info("interest_model.train.done", **meta)
    return meta


def model_status(domain: Domain = "shopping") -> dict:
    path = META_PATH[domain]
    if path.exists():
        return json.loads(path.read_text())
    return {"domain": domain, "status": "untrained", "samples": 0, "trained_at": None}
