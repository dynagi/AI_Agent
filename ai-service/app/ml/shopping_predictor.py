"""Next-purchase predictions from the LightGBM shopping model, plus retraining on real users' history.

Model: P(user orders item X within the next 7 days), scored for every item the user has bought or
looked at (plus popular items in their main categories). Rolled up into "what they'll need next",
which store they'd use, when, and roughly how much it costs.

Learning from use, at two speeds:
  * instantly - every event (a search, a cart add, an agent command) changes the user's features, so
    the very next prediction already reflects it;
  * retraining - each shopping agent command schedules a fine-tune (debounced) that continues the
    synthetic-data base model with new trees fit on all real users' history, then hot-swaps it in.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
import structlog

from app.core.config import settings
from app.ml.shopping_catalog import CATALOG, item_category
from app.ml.shopping_features import FEATURES, NONE, build_frame, normalize_events, preferred_app, to_model_input
from app.ml.shopping_trainer import fit, user_rows

logger = structlog.get_logger()
IST = ZoneInfo("Asia/Kolkata")
BASE_VERSION = "shopping_lightgbm_v1"
REAL_ROW_WEIGHT = 3.0
MIN_REAL_ROWS = 40
MAX_RETRAIN_USERS = 300  # most recently active users per retrain, so it stays a few-seconds job
HOLDOUT_DAYS = 21          # newest weeks a new model is checked against before it's used
MIN_HOLDOUT_ROWS = 20
MIN_HOLDOUT_POSITIVES = 3
SWAP_MARGIN = 0.005        # a candidate must cut held-out log loss by at least 0.5%


def now_ist() -> pd.Timestamp:
    return pd.Timestamp(datetime.now(IST).replace(tzinfo=None))


class ShoppingPredictor:
    def __init__(self, model_dir: Path, runtime_dir: Path):
        self.model_dir = model_dir
        self.runtime_dir = runtime_dir
        self.spec = json.loads((model_dir / f"{BASE_VERSION}.json").read_text())
        self.categories: list[str] = self.spec["categories"]
        self.stats: dict = self.spec["stats"]
        self.base = lgb.Booster(model_file=str(model_dir / f"{BASE_VERSION}.txt"))
        self.model = self.base
        self.meta: dict = {"model": BASE_VERSION, "status": "base", "trainedOn": self.spec["trained_on"],
                           "trainedAt": self.spec["trained_at"]}
        tuned, tuned_meta = runtime_dir / "shopping_finetuned.txt", runtime_dir / "shopping_finetuned.json"
        if tuned.exists() and tuned_meta.exists():
            meta = json.loads(tuned_meta.read_text())
            # only models that passed the held-out check are served (older, unvalidated fine-tunes are ignored)
            if meta.get("baseModel") == BASE_VERSION and meta.get("validation"):
                self.model, self.meta = lgb.Booster(model_file=str(tuned)), meta

    # ------------------------------------------------------------------ predict
    def predict(self, events: list[dict], as_of: pd.Timestamp, extra_items: list[str] | None = None,
                top_k: int = 8) -> dict:
        df, ux = build_frame(events, as_of, self.stats, extra_items)
        if df.empty or not len(ux.order_t):
            return self._cold_start(ux, as_of)
        df["probability"] = self.model.predict(to_model_input(df, self.categories))
        df = df.sort_values("probability", ascending=False)
        t = as_of.value / 86_400e9

        items = []
        for r in df.head(max(top_k, 12)).itertuples():
            d = ux.items.get(r.item)
            app, app_share = preferred_app(ux, r.item, t)
            prices = d["order_price"][d["order_price"] > 0] if d is not None else np.array([])
            unit = float(np.median(prices)) if len(prices) else (CATALOG[r.item][2] if r.item in CATALOG else None)
            qty = max(1, int(round(r.mean_qty))) if r.mean_qty > 0 else 1
            usual_gap = r.mean_gap if r.mean_gap > 0 else (r.global_median_gap if r.global_median_gap > 0 else None)
            items.append({
                "item": r.item, "name": d["name"] if d is not None else r.item, "category": r.category,
                "probability": round(float(r.probability), 3),
                "dueInDays": round(max(r.due_in_days, 0.0), 1) if r.due_in_days != NONE else None,
                "lastOrderedDaysAgo": round(r.days_since_last_order, 1) if r.days_since_last_order != NONE else None,
                "usualGapDays": round(float(usual_gap), 1) if usual_gap else None,
                "timesOrdered": int(r.n_orders), "usualQty": qty,
                "store": app, "storeConfidence": app_share,
                "estimatedPriceInr": round(unit * qty, 0) if unit else None,
                "why": _why(r, app),
            })
        likely = [i for i in items if i["probability"] >= 0.5][:top_k] or items[:3]

        baskets: dict[str, dict] = {}
        for i in likely:
            b = baskets.setdefault(i["store"] or "any store", {"store": i["store"], "items": [], "estimatedAmountInr": 0.0})
            b["items"].append({"name": i["item"], "qty": i["usualQty"]})
            b["estimatedAmountInr"] += i["estimatedPriceInr"] or 0.0
        due = [i["dueInDays"] for i in likely if i["dueInDays"] is not None]
        return {
            "status": "ok",
            "asOf": as_of.isoformat(),
            "model": self.meta,
            "horizonDays": self.spec["horizon_days"],
            "nextPurchases": likely,
            "alsoPossible": [i for i in items if i not in likely][:5],
            "suggestedBaskets": sorted(baskets.values(), key=lambda b: -len(b["items"])),
            "nextOrderInDays": round(min(due), 1) if due else None,
            "history": _history(ux, t),
        }

    def _cold_start(self, ux, as_of: pd.Timestamp) -> dict:
        looked = sorted(ux.items, key=lambda i: -len(ux.items[i]["interact_t"]))[:5]
        popular = sorted(self.stats["items"], key=lambda i: -self.stats["items"][i]["popularity"])[:5]
        return {"status": "cold_start", "asOf": as_of.isoformat(), "model": self.meta, "nextPurchases": [],
                "recentlyLookedAt": looked, "popularItems": popular,
                "detail": "No orders on record yet; personalised predictions start after the first order."}

    # ------------------------------------------------------------------ retrain
    def finetune(self, users_events: dict[str, list[dict]], now: pd.Timestamp, reason: str) -> dict:
        """Safe retrain on real users' history. A candidate (base model + new trees fit on real rows mixed with a
        synthetic sample, so general patterns aren't forgotten) is trained WITHOUT the last HOLDOUT_DAYS, then
        scored on those held-out weeks against the base model: did learning from real history predict what people
        actually bought better? Only a clearly better candidate is promoted (refit on all data, previous model
        kept as a backup). Not enough recent history to check -> nothing changes. Always restarts from the base."""
        t0 = time.time()
        real = self._real_rows(users_events, now)
        result = {"at": now.isoformat(), "trigger": reason, "realRows": len(real),
                  "users": int(real["user_id"].nunique()) if len(real) else 0}
        if len(real) < MIN_REAL_ROWS or real["label"].nunique() < 2:
            return self._retrain_result(result | {"status": "skipped", "reason": "not enough real order history yet"})

        cutoff = now - pd.Timedelta(days=HOLDOUT_DAYS)
        train_real, holdout = real[real["as_of"] < cutoff], real[real["as_of"] >= cutoff]
        if (len(train_real) < MIN_REAL_ROWS or train_real["label"].nunique() < 2 or len(holdout) < MIN_HOLDOUT_ROWS
                or holdout["label"].sum() < MIN_HOLDOUT_POSITIVES):
            return self._retrain_result(result | {
                "status": "skipped", "holdoutRows": len(holdout), "holdoutPositives": int(holdout["label"].sum()),
                "reason": "not enough orders yet to check a new model against recent purchases; keeping the current one"})

        base_rows = joblib.load(self.model_dir / "base_rows_sample.joblib").assign(weight=1.0)
        rounds = int(min(150, 10 + len(train_real) // 50))
        candidate = fit(self._mix(base_rows, train_real), self.categories, rounds=rounds,
                        params={"learning_rate": 0.03}, init_model=self.base)
        scores = {name: _score(m, holdout, self.categories) for name, m in
                  (("candidate", candidate), ("current", self.model), ("base", self.base))}
        # The fair yardstick is the base model: like the candidate, it has never seen the held-out weeks. The
        # serving model was refit on all data at its own promotion, so it may already know part of this period;
        # its score is reported but doesn't decide.
        ref, cand = scores["base"], scores["candidate"]
        better = (cand["logloss"] <= ref["logloss"] * (1 - SWAP_MARGIN)
                  and cand["precisionAt3"] >= ref["precisionAt3"] - 0.02)
        result |= {"holdoutDays": HOLDOUT_DAYS, "holdoutRows": len(holdout),
                   "holdoutPositives": int(holdout["label"].sum()), "scores": scores}
        if not better:
            return self._retrain_result(result | {
                "status": "kept", "seconds": round(time.time() - t0, 1),
                "reason": "a model trained on real history didn't predict recent purchases better than the base model"})

        final_rounds = int(min(150, 10 + len(real) // 50))
        final = fit(self._mix(base_rows, real), self.categories, rounds=final_rounds, params={"learning_rate": 0.03},
                    init_model=self.base)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        current_file = self.runtime_dir / "shopping_finetuned.txt"
        if current_file.exists():
            current_file.replace(self.runtime_dir / "shopping_finetuned_previous.txt")
        final.save_model(str(current_file))
        meta = {"model": f"{BASE_VERSION}+finetuned", "baseModel": BASE_VERSION, "status": "finetuned",
                "trainedOn": f"{self.spec['trained_on']} + {len(real)} rows from {real['user_id'].nunique()} real users",
                "trainedAt": now.isoformat(), "realRows": len(real), "realPositives": int(real["label"].sum()),
                "addedTrees": final_rounds, "validation": scores, "trigger": reason}
        (self.runtime_dir / "shopping_finetuned.json").write_text(json.dumps(meta, indent=1))
        self.model, self.meta = final, meta
        logger.info("shopping_model.promoted", realRows=len(real), candidate=cand, base=ref)
        return self._retrain_result(result | {"status": "trained", "seconds": round(time.time() - t0, 1)})

    def _retrain_result(self, result: dict) -> dict:
        self.meta = {**self.meta, "lastRetrain": result}
        logger.info("shopping_model.retrain", **{k: v for k, v in result.items() if k != "scores"},
                    scores=json.dumps(result.get("scores")) if result.get("scores") else None)
        return result

    @staticmethod
    def _mix(base_rows: pd.DataFrame, real: pd.DataFrame) -> pd.DataFrame:
        real = real.assign(weight=real["weight"] * REAL_ROW_WEIGHT)
        return pd.concat([base_rows, real[FEATURES + ["label", "weight"]]], ignore_index=True)

    def _real_rows(self, users_events: dict[str, list[dict]], now: pd.Timestamp) -> pd.DataFrame:
        rows = []
        recent = sorted(users_events, key=lambda u: max(str(e.get("timestamp") or "") for e in users_events[u]),
                        reverse=True)[:MAX_RETRAIN_USERS]
        for uid in recent:
            ev = normalize_events(users_events[uid])
            ev = ev[ev["timestamp"] <= now].reset_index(drop=True)
            if len(ev) < 3:
                continue
            first = ev["timestamp"].iloc[0] + pd.Timedelta(days=7)
            snaps = list(pd.date_range(first, now - pd.Timedelta(hours=1), freq="2D"))[-90:]
            # a snapshot right before each recent order, so the newest purchases are learnt as positives
            snaps += [ts - pd.Timedelta(minutes=1) for ts in ev[ev["action"] == "order"]["timestamp"].tail(10)]
            for r in user_rows(ev, sorted(set(x for x in snaps if x > ev["timestamp"].iloc[0])), self.stats, now=now):
                r["user_id"] = uid
                rows.append(r)
        return pd.DataFrame(rows)


def _score(model: lgb.Booster, rows: pd.DataFrame, categories: list[str]) -> dict:
    """How well a model predicted held-out purchases: weighted log loss (lower is better) and, per user and day,
    how many of its top-3 items were actually bought (higher is better)."""
    p = np.clip(model.predict(to_model_input(rows, categories)), 1e-6, 1 - 1e-6)
    y, w = rows["label"].to_numpy(), rows["weight"].to_numpy()
    logloss = float(-(w * (y * np.log(p) + (1 - y) * np.log(1 - p))).sum() / w.sum())
    scored = rows.assign(p=p)
    hits = [g.nlargest(3, "p")["label"].mean() for _, g in scored.groupby(["user_id", "as_of"]) if g["label"].any()]
    return {"logloss": round(logloss, 4), "precisionAt3": round(float(np.mean(hits)), 4) if hits else 0.0}


def _why(r, app: str | None) -> str:
    bits = []
    if r.n_orders >= 2 and r.mean_gap > 0:
        bits.append(f"bought {int(r.n_orders)}x, about every {r.mean_gap:.0f} days")
        if r.days_since_last_order != NONE:
            days = round(r.days_since_last_order)
            bits.append("last bought today" if days == 0 else f"last bought {days} day{'s' if days != 1 else ''} ago")
    elif r.n_orders == 1:
        bits.append("bought once before")
    if r.n_search_14d or r.n_view_14d:
        bits.append("recently searched/viewed")
    if r.n_cart_7d:
        bits.append("added to cart recently")
    if r.n_wish_30d:
        bits.append("on the wishlist")
    if not bits:
        bits.append(f"popular in {r.category.replace('_', ' ')}")
    if app:
        bits.append(f"usually from {app}")
    return "; ".join(bits)


def _history(ux, t: float) -> dict:
    order_days = ux.order_day[ux.order_day < np.floor(t) + 1]
    ev = ux.ev[ux.ev["action"] == "order"]
    apps = ev["app"][~ev["app"].isin(["none", "AURA"])].value_counts().head(3)
    top = ev["item"].value_counts().head(5)
    per_day = ev.groupby(ev["timestamp"].dt.date)["amount"].sum()
    return {
        "orderDays": int(len(order_days)),
        "favouriteStores": [{"store": a, "orders": int(n)} for a, n in apps.items()],
        "topItems": [{"item": i, "times": int(n)} for i, n in top.items()],
        "averageOrderValueInr": round(float(per_day.mean()), 0) if len(per_day) else None,
        "lastOrderOn": str(ev["timestamp"].iloc[-1].date()) if len(ev) else None,
    }


# ---------------------------------------------------------------------- singleton + retrain scheduling
_predictor: ShoppingPredictor | None = None
_lock = threading.Lock()


def get_predictor() -> ShoppingPredictor:
    global _predictor
    if _predictor is None:
        with _lock:
            if _predictor is None:
                _predictor = ShoppingPredictor(Path(settings.shopping_model_dir),
                                               Path(settings.shopping_model_runtime_dir))
    return _predictor


class RetrainScheduler:
    """Debounced: each request (re)starts a short timer, so a burst of commands trains once; never more
    often than shopping_retrain_min_interval_s. Training runs in a worker thread."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._last_run = 0.0
        self._running = False
        self.reasons: list[str] = []
        self.last_result: dict | None = None

    def request(self, reason: str) -> dict:
        self.reasons.append(reason)
        if self._task and not self._task.done() and not self._running:
            self._task.cancel()
        if not self._running:
            self._task = asyncio.get_running_loop().create_task(self._run_later())
        wait = max(settings.shopping_retrain_debounce_s,
                   self._last_run + settings.shopping_retrain_min_interval_s - time.time())
        return {"scheduled": True, "inSeconds": round(wait, 0)}

    async def _run_later(self) -> None:
        wait = max(settings.shopping_retrain_debounce_s,
                   self._last_run + settings.shopping_retrain_min_interval_s - time.time())
        await asyncio.sleep(wait)
        await self.run_now()

    async def run_now(self) -> dict:
        from app.services.shopping_history import shopping_history  # avoid import cycle at module load

        self._running = True
        reason = "; ".join(dict.fromkeys(self.reasons))[:300] or "manual"
        self.reasons = []
        try:
            users = await shopping_history.real_users_events()
            self.last_result = await asyncio.to_thread(get_predictor().finetune, users, now_ist(), reason)
        except Exception as exc:  # a failed retrain must never break the agent; keep serving the old model
            logger.exception("shopping_model.retrain_failed", error=str(exc))
            self.last_result = {"status": "failed", "error": str(exc)}
        finally:
            self._last_run = time.time()
            self._running = False
            if self.reasons:  # commands that arrived while training get their own retrain
                self._task = asyncio.get_running_loop().create_task(self._run_later())
        return self.last_result


retrain_scheduler = RetrainScheduler()
