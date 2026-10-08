"""
Synthetic SHOPPING behaviour generator for the AURA next-purchase model.

Pipeline:  user persona -> personal item set with personal repurchase cycles and store preferences
-> event-driven simulation (items fall due, get batched into one order per store, with searches,
views, wishlists and cart adds before purchases, plus browsing noise) -> events CSV.
Features/labels are built later by ai-service/app/ml/shopping_features.py, the same code the
service uses live, so training and serving can't drift.

Everything is synthetic. No real people, names, contacts or payment data.

Usage:
    python generate_shopping.py                       # 3000 users -> shopping/
    python generate_shopping.py --users 300 --seed 7 --out ../ai-service/data --prefix demo_   # demo users
"""
from __future__ import annotations

import argparse
import heapq
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "ai-service"))
from app.ml.shopping_catalog import CATALOG, CATEGORY_APPS, QUICK, GROCERY, MARKET, FASHION  # noqa: E402

START_DATE = pd.Timestamp("2025-01-01")
END_DATE = pd.Timestamp("2026-09-30")

# share, item inclusion probabilities by category, cycle multiplier, regularity (gamma k), qty multiplier,
# store bias (multiplier per store group), occasional purchases per year {category: rate}
PERSONAS = {
    "bachelor": dict(share=0.20, cats={"dairy": .7, "bakery": .7, "snacks": .8, "beverages": .7, "household": .5,
                                       "personal_care": .6, "fruits_vegetables": .3, "staples": .2},
                     cyc=1.2, k=2.5, qty=1.0, bias={"quick": 4.0, "grocery": .4, "market": 1.0, "fashion": 1.0},
                     occ={"electronics": 2.0, "fashion": 2.0, "books": .5}),
    "young_couple": dict(share=0.18, cats={"dairy": .9, "bakery": .7, "fruits_vegetables": .8, "staples": .6,
                                           "snacks": .6, "beverages": .6, "household": .7, "personal_care": .8},
                         cyc=1.0, k=3.0, qty=1.2, bias={"quick": 2.5, "grocery": 1.2, "market": 1.0, "fashion": 1.0},
                         occ={"fashion": 3.0, "home": 1.5, "electronics": 1.0}),
    "family": dict(share=0.24, cats={"dairy": .95, "bakery": .6, "fruits_vegetables": .95, "staples": .95,
                                     "snacks": .6, "beverages": .7, "household": .9, "personal_care": .9, "baby": .45},
                   cyc=0.8, k=4.0, qty=1.8, bias={"quick": 1.5, "grocery": 2.5, "market": 1.0, "fashion": .6},
                   occ={"home": 2.0, "fashion": 2.0, "books": 1.0, "electronics": .7}),
    "health_enthusiast": dict(share=0.12, cats={"dairy": .9, "fruits_vegetables": .95, "health": .9, "staples": .5,
                                                "beverages": .5, "personal_care": .7, "household": .5},
                              cyc=1.0, k=3.5, qty=1.1, bias={"quick": 2.0, "grocery": 1.0, "market": 1.6, "fashion": 1.0},
                              occ={"fashion": 2.0, "electronics": 1.0, "books": 1.5}),
    "budget_shopper": dict(share=0.16, cats={"dairy": .8, "staples": .95, "fruits_vegetables": .8, "household": .9,
                                             "personal_care": .8, "snacks": .3, "beverages": .5},
                           cyc=1.6, k=2.0, qty=2.2, bias={"quick": .5, "grocery": 4.0, "market": 1.2, "fashion": .4},
                           occ={"home": .7, "fashion": .8}),
    "fashion_tech": dict(share=0.10, cats={"dairy": .5, "snacks": .6, "beverages": .6, "personal_care": .8,
                                           "household": .4, "bakery": .4},
                         cyc=1.3, k=2.0, qty=1.0, bias={"quick": 2.5, "grocery": .5, "market": 2.0, "fashion": 3.0},
                         occ={"fashion": 7.0, "electronics": 4.0, "books": 1.0}),
}

STORE_GROUP = {**{a: "quick" for a in QUICK}, **{a: "grocery" for a in GROCERY}, **{a: "market" for a in MARKET},
               **{a: "fashion" for a in FASHION}}
REPEAT_ITEMS = {i: v for i, v in CATALOG.items() if v[1] is not None}
OCCASIONAL = {}
for _i, (_c, _cyc, *_r) in CATALOG.items():
    if _cyc is None:
        OCCASIONAL.setdefault(_c, []).append(_i)


def make_user(rng: np.random.Generator, uid: str) -> dict:
    names = list(PERSONAS)
    persona = rng.choice(names, p=np.array([PERSONAS[n]["share"] for n in names]) / sum(PERSONAS[n]["share"] for n in names))
    P = PERSONAS[persona]
    items = {}
    for item, (cat, cycle, price, _) in REPEAT_ITEMS.items():
        p = P["cats"].get(cat, 0.0)
        if cat == "pet":
            p = 0.15
        if cat == "baby" and persona != "family":
            p = 0.03
        if rng.random() < p * rng.uniform(0.6, 1.0):
            items[item] = dict(cycle=max(1.0, cycle * P["cyc"] * rng.lognormal(0, 0.25)),
                               qty=max(1, int(round(P["qty"] * rng.uniform(0.7, 1.4)))))
    # store preference: per category, a Dirichlet over its stores tilted by persona; one "home" quick app is sticky
    home_quick = rng.choice(QUICK, p=[.42, .35, .23])
    store_pref = {}
    for cat, stores in CATEGORY_APPS.items():
        w = np.array([P["bias"][STORE_GROUP[s]] * (3.0 if s == home_quick else 1.0) for s in stores])
        store_pref[cat] = (stores, rng.dirichlet(w * 2))
    start = START_DATE + pd.Timedelta(days=float(rng.uniform(0, 150)))
    return dict(user_id=uid, persona=persona, items=items, store_pref=store_pref, start=start,
                k=P["k"], occ=P["occ"], home_quick=home_quick)


def pick_store(rng, user, cat):
    stores, w = user["store_pref"][cat]
    return stores[rng.choice(len(stores), p=w)]


HOURS = np.array([8, 9, 10, 13, 18, 19, 20, 21, 22]) / 24
HOUR_P = [.12, .12, .08, .08, .1, .15, .17, .12, .06]


def shop_time(rng, day: float) -> float:
    """A plausible shopping time of day on the same day. Times are float days since START_DATE."""
    return np.floor(day) + rng.choice(HOURS, p=HOUR_P) + rng.integers(0, 60) / 1440


def simulate(rng: np.random.Generator, user: dict) -> list[tuple]:
    ev: list[tuple] = []
    uid = user["user_id"]
    start = (user["start"] - START_DATE).days
    end = (END_DATE - START_DATE).days

    def add(t, action, item, app, qty=1, price=0.0, source="app"):
        ev.append((uid, t, action, item, item, CATALOG[item][0], app, qty, round(price, 2),
                   round(price * qty, 2) if action == "order" else 0.0, source))

    # vacations: no orders during these windows
    away = [(a, a + rng.integers(4, 15)) for a in start + rng.uniform(0, 600, rng.poisson(1.5))]

    def is_away(t):
        return any(a <= t <= b for a, b in away)

    # ---- repeat items: event-driven, batched into per-store orders ----
    heap = [(start + rng.uniform(0, cfg["cycle"]), item) for item, cfg in user["items"].items()]
    heapq.heapify(heap)
    while heap:
        due, item = heapq.heappop(heap)
        if due > end:
            continue
        cat = CATALOG[item][0]
        if is_away(due):
            heapq.heappush(heap, (due + rng.uniform(3, 10), item))
            continue
        day = shop_time(rng, due)
        app = pick_store(rng, user, cat)
        basket = [item]
        # pull in other items due soon that this store sells (people fill the basket)
        pulled = [(d2, it2) for d2, it2 in heap
                  if d2 <= due + 2 and app in CATEGORY_APPS[CATALOG[it2][0]] and rng.random() < 0.6]
        if pulled:
            heap = [h for h in heap if h not in pulled]
            heapq.heapify(heap)
            basket += [it2 for _, it2 in pulled]
        for it in basket:
            cfg = user["items"][it]
            price = CATALOG[it][2] * rng.uniform(0.85, 1.2)
            qty = max(1, cfg["qty"] + int(rng.integers(-1, 2) * (rng.random() < 0.2)))
            if rng.random() < 0.12:  # sometimes searched first (forgot, comparing)
                add(day - rng.uniform(0.01, 1.25), "search", it, app)
            if rng.random() < 0.5:
                add(day - rng.uniform(1, 25) / 1440, "add_to_cart", it, app, qty, price)
            add(day, "order", it, app, qty, price)
            if rng.random() < 0.01:
                add(day + rng.uniform(1, 20) / 1440, "cancel", it, app, qty, price)
            k = user["k"] * (2.0 if cfg["cycle"] <= 3 else 1.0)
            heapq.heappush(heap, (day + max(0.6, rng.gamma(k, cfg["cycle"] / k)), it))

    # ---- occasional purchases: research first, sometimes abandon ----
    span = end - start
    for cat, rate in user["occ"].items():
        for _ in range(rng.poisson(rate * span / 365)):
            item = rng.choice(OCCASIONAL[cat])
            buy = start + rng.uniform(5, span)
            app = pick_store(rng, user, cat)
            for _ in range(rng.integers(1, 6)):
                add(buy - rng.uniform(0, 8), rng.choice(["search", "view", "view"]), item,
                    rng.choice([app, pick_store(rng, user, cat)]))
            if rng.random() < 0.3:
                add(buy - rng.uniform(0.5, 5), "wishlist", item, app)
            if rng.random() < 0.7:
                add(shop_time(rng, buy), "order", item, app, 1, CATALOG[item][2] * rng.lognormal(0, 0.35))

    # ---- browsing noise + explicit not-interested ----
    items = list(CATALOG)
    for _ in range(rng.poisson(span / 12)):
        item = items[rng.integers(len(items))]
        add(start + rng.uniform(0, span) + rng.uniform(8, 23) / 24,
            rng.choice(["view", "search", "not_interested"], p=[.6, .3, .1]), item,
            pick_store(rng, user, CATALOG[item][0]))
    return ev


COLUMNS = ["user_id", "t", "action", "item", "name", "category", "app", "qty", "price", "amount", "source"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(HERE / "shopping"))
    ap.add_argument("--prefix", default="")
    ap.add_argument("--id-offset", type=int, default=0)
    ap.add_argument("--since", default=None, help="only write events from this date (smaller demo files)")
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    users, events = [], []
    for n in range(args.users):
        u = make_user(rng, f"USER_{n + args.id_offset:06d}")
        events += simulate(rng, u)
        users.append(dict(user_id=u["user_id"], persona=u["persona"], home_quick_app=u["home_quick"],
                          regular_items=sorted(u["items"]), active_from=str(u["start"].date())))
    df = pd.DataFrame(events, columns=COLUMNS)
    df = df[(df["t"] >= 0) & (df["t"] <= (END_DATE - START_DATE).days)]
    df["timestamp"] = START_DATE + pd.to_timedelta(df.pop("t").round(5), unit="D")
    df = df[["user_id", "timestamp"] + COLUMNS[2:]]
    if args.since:
        df = df[df["timestamp"] >= pd.Timestamp(args.since)]
    df = df.sort_values(["user_id", "timestamp"], kind="mergesort")
    df["timestamp"] = df["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%S")
    df.to_csv(out / f"{args.prefix}shopping_events.csv", index=False)
    (out / f"{args.prefix}shopping_users.json").write_text(json.dumps(users, indent=1))
    orders = df[df["action"] == "order"]
    print(f"{len(users)} users, {len(df):,} events, {len(orders):,} order lines, "
          f"{orders.groupby('user_id').size().median():.0f} median order lines/user -> {out}")
    print(df["action"].value_counts().to_string())


if __name__ == "__main__":
    main()
