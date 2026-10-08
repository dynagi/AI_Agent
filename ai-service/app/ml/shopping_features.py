"""Turns one user's shopping events into model rows: one row per (candidate item, snapshot time).

This single module is used by the synthetic training script, the in-service retrainer and live
predictions, so training and serving can never compute features differently. Only events strictly
before `as_of` are used for features; the label looks at orders in (as_of, as_of + HORIZON_DAYS].
"""
from __future__ import annotations

from collections import Counter

import numpy as np
import pandas as pd

from app.ml.shopping_catalog import (CATALOG, FOOD_APPS, RESTAURANT_FOOD, canonical_app, canonical_item, dish_item,
                                     item_category)

HORIZON_DAYS = 7.0
APP_TAU_DAYS = 60.0
MAX_CANDIDATES = 40
NONE = 999.0  # "never happened" for days-since style features

EVENT_COLUMNS = ["timestamp", "action", "item", "name", "category", "app", "qty", "price", "amount", "source"]
ACTIONS = {"search", "view", "wishlist", "add_to_cart", "order", "cancel", "not_interested"}
CATEGORICAL = ["category"]

FEATURES = [
    # item history
    "n_orders", "n_orders_30d", "n_orders_90d", "days_since_last_order", "mean_gap", "median_gap", "std_gap",
    "gap_ratio", "due_in_days", "last_qty", "mean_qty", "days_since_first_seen",
    # recent intent signals on this item
    "n_search_3d", "n_search_14d", "n_view_14d", "n_cart_7d", "n_wish_30d", "n_not_interested_30d",
    "days_since_last_interaction",
    # item priors
    "category", "catalog_cycle", "log_catalog_price", "item_known", "global_popularity", "global_median_gap",
    # category + user context
    "cat_share", "cat_days_since_last_order", "u_orders_total", "u_order_days_30d", "u_days_since_last_order",
    "u_mean_order_gap", "u_n_items", "dow", "dom",
]


def normalize_events(events: pd.DataFrame | list[dict]) -> pd.DataFrame:
    """Coerces events from any source (CSV, Supabase JSON, API payload) into one schema, sorted by time."""
    df = pd.DataFrame(events).copy()
    for c in EVENT_COLUMNS:
        if c not in df:
            df[c] = None
    df["timestamp"] = _to_india_naive(df["timestamp"])
    df = df[df["timestamp"].notna()]
    df["action"] = df["action"].astype(str).str.lower()
    df = df[df["action"].isin(ACTIONS)]
    # A cart AURA filled, or a command to fill one, is intent: AURA can't see whether it was paid for. Real
    # purchases come from the stores' own order history and from invoices.
    ours = df["source"].isin(["agent_command", "cart_agent"]) & (df["action"] == "order")
    df.loc[ours, "action"] = "add_to_cart"
    # the product name is the source of truth (labels stored earlier may come from an older matcher)
    has_name = df["name"].notna() & (df["name"].astype(str).str.strip() != "")
    raw_item = df["name"].where(has_name, df["item"])
    df["app"] = [canonical_app(a if isinstance(a, str) else None) for a in df["app"]]
    # restaurant food (by category, or anything from a food-delivery app) keeps the dish as the item
    food = (df["category"].astype(str) == RESTAURANT_FOOD) | df["app"].isin(FOOD_APPS)
    df["item"] = [dish_item(v if isinstance(v, str) else None) if f else canonical_item(v if isinstance(v, str) else None)
                  for v, f in zip(raw_item, food)]
    df["category"] = [RESTAURANT_FOOD if f else
                      (c if isinstance(c, str) and c and c != "none" and it not in CATALOG else item_category(it))
                      for c, it, f in zip(df["category"], df["item"], food)]
    keep = df["item"] != "none"
    df = df[keep]
    df["name"] = df["name"].where(df["name"].notna(), df["item"]).astype(str)
    df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(1.0).clip(lower=0)
    df["price"] = pd.to_numeric(df["price"], errors="coerce").fillna(0.0)
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(df["price"] * df["qty"])
    df["source"] = df["source"].where(df["source"].notna(), "app").astype(str)
    df = df.sort_values("timestamp", kind="mergesort").reset_index(drop=True)
    # the same order line read twice from a store screen ("48 g" vs "48g"): one purchase
    imported = df["source"].isin(["store_history", "invoice"]) & (df["action"] == "order")
    key = (df["app"].astype(str) + "|" + df["timestamp"].dt.strftime("%Y-%m-%d").astype(str) + "|"
           + df["name"].astype(str).str.lower().str.replace(r"[^a-z0-9]", "", regex=True))
    df = df[~(imported & key.duplicated())].reset_index(drop=True)
    return _collapse_repeat_commands(df)


REPEAT_WINDOW = pd.Timedelta(hours=12)


def _collapse_repeat_commands(df: pd.DataFrame) -> pd.DataFrame:
    """Orders AURA created (agent commands, filled carts) for the same item within 12 hours count once: retries
    and test runs are not purchases. Orders read from the store app's own history are kept as they are."""
    is_ours = (df["action"] == "order") & df["source"].isin(["agent_command", "cart_agent"])
    if is_ours.sum() < 2:
        return df
    drop = []
    last: dict[str, pd.Timestamp] = {}
    for i in df.index[is_ours]:
        item, ts = df.at[i, "item"], df.at[i, "timestamp"]
        if item in last and ts - last[item] < REPEAT_WINDOW:
            drop.append(i)
        else:
            last[item] = ts
    return df.drop(index=drop).reset_index(drop=True)


def _to_india_naive(values: pd.Series) -> pd.Series:
    """Naive timestamps are taken as India time; zone-aware ones are converted to IST."""
    try:
        ts = pd.to_datetime(values.replace("", None), format="mixed")
        if getattr(ts.dt, "tz", None) is not None:
            ts = ts.dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
        return ts.astype("datetime64[ns]")
    except (ValueError, TypeError):  # mixed naive/aware values: one at a time
        pass

    def one(v):
        if v is None or (isinstance(v, float) and np.isnan(v)) or v == "":
            return pd.NaT
        try:
            ts = pd.Timestamp(v)
        except (ValueError, TypeError):
            return pd.NaT
        return ts.tz_convert("Asia/Kolkata").tz_localize(None) if ts.tzinfo else ts

    return pd.Series([one(v) for v in values], index=values.index, dtype="datetime64[ns]")


def _days(ts: pd.Series | pd.Timestamp) -> np.ndarray | float:
    if isinstance(ts, pd.Timestamp):
        return ts.value / 86_400e9
    return ts.astype("int64").to_numpy() / 86_400e9


class _UserIndex:
    """Per-item sorted time arrays for one user, so many snapshots are cheap (searchsorted)."""

    def __init__(self, ev: pd.DataFrame):
        self.ev = ev
        t = _days(ev["timestamp"]) if len(ev) else np.array([])
        self.t = t
        orders = ev["action"].to_numpy() == "order"
        self.order_t = t[orders]
        self.order_day = np.unique(np.floor(self.order_t))
        self.items: dict[str, dict] = {}
        for item, g in ev.groupby("item", sort=False):
            idx = g.index.to_numpy()
            act = g["action"].to_numpy()
            gt = t[idx]
            is_o = act == "order"
            self.items[item] = {
                "category": g["category"].iloc[-1],
                "order_t": gt[is_o],
                "order_qty": g["qty"].to_numpy()[is_o],
                "order_app": g["app"].to_numpy()[is_o],
                "order_price": g["price"].to_numpy()[is_o],
                "first_t": gt[0],
                **{f"{a}_t": gt[act == a] for a in ("search", "view", "add_to_cart", "wishlist", "not_interested")},
                "interact_t": gt[~is_o],
                "name": g["name"].iloc[-1],
            }
        self.cat_order_t: dict[str, np.ndarray] = {}
        for item, d in self.items.items():
            c = d["category"]
            self.cat_order_t[c] = np.sort(np.concatenate([self.cat_order_t.get(c, np.array([])), d["order_t"]]))


def _count_between(arr: np.ndarray, lo: float, hi: float) -> int:
    return int(np.searchsorted(arr, hi, side="left") - np.searchsorted(arr, lo, side="left"))


def _before(arr: np.ndarray, t: float) -> np.ndarray:
    return arr[: np.searchsorted(arr, t, side="left")]


def candidate_items(ux: _UserIndex, t: float, stats: dict, extra: list[str] | None = None) -> list[str]:
    """Items this user touched before t (most recent first), their top categories' popular items, plus extras."""
    seen = []
    for item, d in ux.items.items():
        if d["first_t"] < t:
            last = max(_before(d["order_t"], t).max(initial=-1e9), _before(d["interact_t"], t).max(initial=-1e9))
            seen.append((last, item))
    seen.sort(reverse=True)
    cands = [i for _, i in seen][:MAX_CANDIDATES]
    cat_counts = Counter()
    for item in cands:
        cat_counts[ux.items[item]["category"]] += len(_before(ux.items[item]["order_t"], t))
    for cat, _ in cat_counts.most_common(2):
        for item in stats.get("popular_by_category", {}).get(cat, [])[:4]:
            if item not in cands and len(cands) < MAX_CANDIDATES + 8:
                cands.append(item)
    for item in extra or []:
        if item not in cands:
            cands.append(item)
    return cands


def feature_rows(ux: _UserIndex, as_of: pd.Timestamp, stats: dict, extra: list[str] | None = None,
                 with_label: bool = False) -> list[dict]:
    t = _days(as_of)
    orders_before = _before(ux.order_t, t)
    order_days = _before(ux.order_day, np.floor(t))
    u_gaps = np.diff(order_days)
    total_orders = max(len(orders_before), 1)
    user = {
        "u_orders_total": float(len(orders_before)),
        "u_order_days_30d": float(_count_between(ux.order_day, np.floor(t) - 30, np.floor(t))),
        "u_days_since_last_order": t - orders_before[-1] if len(orders_before) else NONE,
        "u_mean_order_gap": float(u_gaps.mean()) if len(u_gaps) else -1.0,
        "u_n_items": float(sum(1 for d in ux.items.values() if len(_before(d["order_t"], t)))),
        "dow": float(as_of.dayofweek), "dom": float(as_of.day),
    }
    gstats = stats.get("items", {})
    rows = []
    for item in candidate_items(ux, t, stats, extra):
        d = ux.items.get(item)
        cat = d["category"] if d else item_category(item)
        cat_cycle, price = (CATALOG[item][1], CATALOG[item][2]) if item in CATALOG else (None, None)
        g = gstats.get(item, {})
        if d is not None:
            o = _before(d["order_t"], t)
            qty = d["order_qty"][: len(o)]
            gaps = np.diff(o)
            since = t - o[-1] if len(o) else NONE
            mean_gap = float(gaps.mean()) if len(gaps) else -1.0
            prior_gap = mean_gap if mean_gap > 0 else (g.get("median_gap") or cat_cycle or -1.0)
            inter = _before(d["interact_t"], t)
            item_feats = {
                "n_orders": float(len(o)),
                "n_orders_30d": float(_count_between(d["order_t"], t - 30, t)),
                "n_orders_90d": float(_count_between(d["order_t"], t - 90, t)),
                "days_since_last_order": since,
                "mean_gap": mean_gap,
                "median_gap": float(np.median(gaps)) if len(gaps) else -1.0,
                "std_gap": float(gaps.std()) if len(gaps) > 1 else -1.0,
                "gap_ratio": since / prior_gap if len(o) and prior_gap and prior_gap > 0 else -1.0,
                "due_in_days": prior_gap - since if len(o) and prior_gap and prior_gap > 0 else NONE,
                "last_qty": float(qty[-1]) if len(qty) else 0.0,
                "mean_qty": float(qty.mean()) if len(qty) else 0.0,
                "days_since_first_seen": t - d["first_t"] if d["first_t"] < t else 0.0,
                "n_search_3d": float(_count_between(d["search_t"], t - 3, t)),
                "n_search_14d": float(_count_between(d["search_t"], t - 14, t)),
                "n_view_14d": float(_count_between(d["view_t"], t - 14, t)),
                "n_cart_7d": float(_count_between(d["add_to_cart_t"], t - 7, t)),
                "n_wish_30d": float(_count_between(d["wishlist_t"], t - 30, t)),
                "n_not_interested_30d": float(_count_between(d["not_interested_t"], t - 30, t)),
                "days_since_last_interaction": t - inter[-1] if len(inter) else NONE,
            }
        else:
            item_feats = {f: 0.0 for f in ["n_orders", "n_orders_30d", "n_orders_90d", "last_qty", "mean_qty",
                                           "days_since_first_seen", "n_search_3d", "n_search_14d", "n_view_14d",
                                           "n_cart_7d", "n_wish_30d", "n_not_interested_30d"]}
            item_feats.update(days_since_last_order=NONE, mean_gap=-1.0, median_gap=-1.0, std_gap=-1.0,
                              gap_ratio=-1.0, due_in_days=NONE, days_since_last_interaction=NONE)
        cat_o = _before(ux.cat_order_t.get(cat, np.array([])), t)
        row = {
            "item": item, **item_feats, **user,
            "category": cat,
            "catalog_cycle": float(cat_cycle) if cat_cycle else -1.0,
            "log_catalog_price": float(np.log1p(price)) if price else -1.0,
            "item_known": 1.0 if item in CATALOG else 0.0,
            "global_popularity": float(g.get("popularity", 0.0)),
            "global_median_gap": float(g.get("median_gap") or -1.0),
            "cat_share": len(cat_o) / total_orders,
            "cat_days_since_last_order": t - cat_o[-1] if len(cat_o) else NONE,
        }
        if with_label:
            row["label"] = int(d is not None and _count_between(d["order_t"], t + 1e-9, t + HORIZON_DAYS + 1e-9) > 0)
        rows.append(row)
    return rows


def build_frame(events: pd.DataFrame | list[dict], as_of: pd.Timestamp, stats: dict,
                extra_items: list[str] | None = None) -> tuple[pd.DataFrame, _UserIndex]:
    ev = normalize_events(events)
    ev = ev[ev["timestamp"] < as_of].reset_index(drop=True)
    ux = _UserIndex(ev)
    extra = [canonical_item(i) for i in (extra_items or [])]
    return pd.DataFrame(feature_rows(ux, as_of, stats, extra)), ux


def to_model_input(df: pd.DataFrame, categories: list[str]) -> pd.DataFrame:
    X = df[FEATURES].copy()
    X["category"] = pd.Categorical(X["category"].where(X["category"].isin(categories), "other"),
                                   categories=categories)
    return X


def preferred_app(ux: _UserIndex, item: str, t: float) -> tuple[str | None, float]:
    """Store this user is most likely to buy `item` from: decayed counts for the item, then its category,
    then any order. Returns (app, share)."""
    def pick(times: np.ndarray, apps: np.ndarray):
        keep = times < t
        if not keep.any():
            return None
        w = np.exp(-(t - times[keep]) / APP_TAU_DAYS)
        scores: Counter = Counter()
        for a, wi in zip(apps[keep], w):
            if a not in ("none", "AURA"):
                scores[a] += wi
        if not scores:
            return None
        app, s = scores.most_common(1)[0]
        return app, round(s / sum(scores.values()), 3)

    d = ux.items.get(item)
    if d is not None and (r := pick(d["order_t"], d["order_app"])):
        return r
    cat = d["category"] if d else item_category(item)
    same_cat = [x for x in ux.items.values() if x["category"] == cat]
    for pool in (same_cat, list(ux.items.values())):
        if pool:
            times = np.concatenate([x["order_t"] for x in pool])
            apps = np.concatenate([x["order_app"] for x in pool])
            if r := pick(times, apps):
                return r
    return None, 0.0


def compute_stats(events: pd.DataFrame) -> dict:
    """Catalog-level priors from a (normalized, multi-user) event table: popularity and typical gap per item,
    most popular items per category. Saved next to the model and used at serving time."""
    orders = events[events["action"] == "order"]
    n_users = max(events["user_id"].nunique(), 1)
    items = {}
    for item, g in orders.groupby("item"):
        gaps = []
        for _, ug in g.groupby("user_id"):
            days = np.unique(np.floor(_days(ug["timestamp"])))
            gaps += list(np.diff(days))
        items[item] = {"popularity": round(g["user_id"].nunique() / n_users, 4),
                       "median_gap": float(np.median(gaps)) if gaps else None}
    popular: dict[str, list[str]] = {}
    for cat, g in orders.groupby("category"):
        popular[cat] = list(g.groupby("item")["user_id"].nunique().sort_values(ascending=False).index[:8])
    return {"items": items, "popular_by_category": popular}
