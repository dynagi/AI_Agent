"""Long-term shopping memory as structured preferences, each with a confidence.

Built from two kinds of evidence, never from raw chat text:
  * purchases - orders read from the stores' own history and from invoices (what was really bought, where, for how
    much, how often);
  * decisions - every time the user picked between options AURA showed ("Zepto", "the cheaper one"), stored as a
    `decision` record with the options that were on the table.

From these: per item, the usual product (brand / variant / size), quantity, provider and how sure we are of it,
purchase rhythm and typical price; and across items, whether this user tends to choose the faster or the cheaper
option when they differ. Confidence grows with evidence, so one order is a hint and ten are a habit.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from app.ml.shopping_catalog import CATALOG, RESTAURANT_FOOD, canonical_app, canonical_item, dish_item
from app.ml.shopping_features import normalize_events

DECISION = "decision"            # not a model action: normalize_events ignores it
RECENCY_DAYS = 90.0
_SIZE = re.compile(r"(\d+(?:\.\d+)?)\s*(kg|gms?|g|ml|ltr|litres?|liters?|l|pcs?|pieces?|pack|dozen)\b", re.I)
_UNIT = {"kg": ("g", 1000), "g": ("g", 1), "gm": ("g", 1), "gms": ("g", 1), "ml": ("ml", 1), "l": ("ml", 1000),
         "ltr": ("ml", 1000), "litre": ("ml", 1000), "litres": ("ml", 1000), "liter": ("ml", 1000),
         "liters": ("ml", 1000), "pc": ("pc", 1), "pcs": ("pc", 1), "piece": ("pc", 1), "pieces": ("pc", 1),
         "pack": ("pack", 1), "dozen": ("pc", 12)}
BRANDS = ["amul", "nandini", "mother dairy", "country delight", "heritage", "nestle", "britannia", "english oven",
          "harvest gold", "modern", "aashirvaad", "fortune", "tata", "india gate", "daawat", "saffola", "maggi",
          "nissin", "lays", "lay's", "haldiram", "haldirams", "kurkure", "parle", "sunfeast", "cadbury", "colgate",
          "pepsodent", "sensodyne", "dettol", "lux", "dove", "surf excel", "ariel", "tide", "vim", "harpic", "lizol",
          "pampers", "huggies", "pedigree", "coca-cola", "pepsi", "tropicana", "real", "mdh", "everest", "sid's farm",
          "akshayakalpa", "id", "epigamia", "bru", "nescafe", "red label", "taj mahal"]


def normalize_product(name: str, item: str | None = None) -> dict:
    """'Amul Taaza Homogenised Toned Milk 1L' -> {brand: Amul, variant: taaza homogenised toned, category: milk,
    quantity: '1 l'}. The same product named differently by different stores normalises to the same thing."""
    text = re.sub(r"\s+", " ", str(name or "")).strip()
    low = text.lower().replace("’", "'")
    item = item or canonical_item(text)
    size = None
    m = _SIZE.search(low)
    if m:
        unit, mult = _UNIT[m.group(2).lower()]
        value = float(m.group(1)) * mult
        size = (f"{value / 1000:g} {'l' if unit == 'ml' else 'kg'}" if unit in ("ml", "g") and value >= 1000
                else f"{value:g} {unit}")
    brand = next((b for b in sorted(BRANDS, key=len, reverse=True) if re.search(rf"(?<![a-z]){re.escape(b)}(?![a-z])", low)), None)
    rest = _SIZE.sub(" ", low)
    if brand:
        rest = rest.replace(brand, " ")
    keywords = CATALOG[item][3] if item in CATALOG else ()
    for kw in sorted(keywords, key=len, reverse=True):
        rest = re.sub(rf"(?<![a-z]){re.escape(kw)}s?(?![a-z])", " ", rest)
    variant = re.sub(r"[^a-z0-9 ]", " ", rest)
    variant = re.sub(r"\b(pack|of|pouch|bottle|box|tetra|jar|pc|pcs|x|g|ml|l|kg)\b", " ", variant)
    variant = re.sub(r"\s+", " ", variant).strip()
    return {"brand": brand.title() if brand else None, "category": item, "variant": variant or None,
            "quantity": size, "name": text}


def same_product(a: dict, b: dict) -> bool:
    """Same underlying product across stores: same thing, same brand, same size (when both state one)."""
    if a["category"] != b["category"]:
        return False
    if a["brand"] and b["brand"] and a["brand"] != b["brand"]:
        return False
    if a["quantity"] and b["quantity"] and a["quantity"] != b["quantity"]:
        return False
    return bool(a["brand"] and b["brand"]) or a["name"].lower() == b["name"].lower()


@dataclass
class ItemPreference:
    item: str
    product: str                      # the exact product they usually buy
    normalized: dict
    category: str
    usual_qty: int
    provider: str | None              # where they usually buy it
    provider_confidence: float        # 0..1: share of (recent) purchases and choices there, damped by evidence
    providers: dict[str, float]       # share per provider
    times_ordered: int
    typical_gap_days: float | None
    last_ordered_days_ago: int | None
    typical_price: float | None       # per unit
    last_price: dict[str, dict]       # provider -> {price, date}: the user's own last order there
    restaurant: str | None = None
    rejected_providers: list[str] = field(default_factory=list)

    @property
    def known(self) -> bool:
        """Enough history to call it 'their usual' (a repeat purchase of a specific product)."""
        return self.times_ordered >= 2

    def to_dict(self) -> dict:
        return {**asdict(self), "known": self.known}


@dataclass
class ShoppingPreferences:
    items: dict[str, ItemPreference]
    price_weight: float               # learnt: how much a lower price sways their choice...
    speed_weight: float               # ...versus faster delivery (they sum to 1)
    weights_confidence: float         # 0 = no evidence yet (weights are a neutral 50/50)
    decisions: int
    provider_by_category: dict[str, str]

    def for_item(self, name: str, food: bool = False) -> ItemPreference | None:
        key = dish_item(name) if food else canonical_item(name)
        return self.items.get(key)

    def to_dict(self) -> dict:
        return {"items": [p.to_dict() for p in sorted(self.items.values(), key=lambda p: -p.times_ordered)],
                "price_weight": self.price_weight, "speed_weight": self.speed_weight,
                "weights_confidence": self.weights_confidence, "decisions": self.decisions,
                "provider_by_category": self.provider_by_category}


def _evidence(n: float) -> float:
    """0 with no evidence, ~0.5 after two observations, approaching 1 with many."""
    return n / (n + 2.0)


def learn_weights(decisions: list[dict]) -> tuple[float, float, float, int]:
    """From choices where the cheapest and the fastest option differed: which did they take?"""
    speed = price = 0
    for d in decisions:
        opts = [o for o in d.get("options") or [] if o.get("final_cost") is not None and o.get("eta_minutes") is not None]
        if len(opts) < 2:
            continue
        cheapest = min(opts, key=lambda o: o["final_cost"])["provider"]
        fastest = min(opts, key=lambda o: o["eta_minutes"])["provider"]
        if cheapest == fastest:
            continue  # no trade-off to learn from
        chosen = canonical_app(d.get("chosen"))
        if chosen == fastest:
            speed += 1
        elif chosen == cheapest:
            price += 1
    n = speed + price
    speed_weight = round((speed + 1) / (n + 2), 3)  # Laplace: 50/50 until there is evidence
    return round(1 - speed_weight, 3), speed_weight, round(_evidence(n), 3), n


def build_preferences(events: list[dict]) -> ShoppingPreferences:
    decisions = [e for e in events if e.get("action") == DECISION]
    ev = normalize_events(events)
    orders = ev[ev["action"] == "order"]
    now = ev["timestamp"].max() if len(ev) else pd.Timestamp.now()
    chosen_by_item: dict[str, Counter] = defaultdict(Counter)
    passed_by_item: dict[str, Counter] = defaultdict(Counter)
    for d in decisions:
        key = str(d.get("item") or "")
        chosen = canonical_app(d.get("chosen"))
        chosen_by_item[key][chosen] += 1
        for o in d.get("options") or []:
            if canonical_app(o.get("provider")) != chosen:
                passed_by_item[key][canonical_app(o.get("provider"))] += 1

    items: dict[str, ItemPreference] = {}
    for item, g in orders.groupby("item"):
        age = (now - g["timestamp"]).dt.days.clip(lower=0).to_numpy()
        w = np.exp(-age / RECENCY_DAYS)
        names = pd.Series(w, index=g["name"].str.strip()).groupby(level=0).sum().sort_values(ascending=False)
        product = str(names.index[0])
        shares: Counter = Counter()
        for app, wi in zip(g["app"], w):
            if app not in ("none", "AURA"):
                shares[app] += wi
        for app, n in chosen_by_item.get(item, {}).items():
            shares[app] += 1.5 * n          # an explicit choice counts more than a passive purchase
        total = sum(shares.values())
        providers = {a: round(s / total, 3) for a, s in shares.most_common()} if total else {}
        top = next(iter(providers), None)
        n_evidence = len(g) + sum(chosen_by_item.get(item, {}).values())
        days = np.unique(g["timestamp"].dt.normalize())
        gaps = np.diff(days).astype("timedelta64[D]").astype(float) if len(days) > 1 else np.array([])
        prices = g["price"][g["price"] > 0]
        last_price = {}
        for app, ag in g[g["price"] > 0].groupby("app"):
            last = ag.iloc[-1]
            last_price[app] = {"price": float(last["price"]), "date": str(last["timestamp"].date())}
        rejected = [a for a, n in passed_by_item.get(item, {}).items() if n >= 2 and chosen_by_item[item].get(a, 0) == 0]
        restaurant = None
        if "restaurant" in g:
            r = g["restaurant"].dropna()
            restaurant = str(r.mode().iloc[0]) if len(r) else None
        items[item] = ItemPreference(
            item=item, product=product, normalized=normalize_product(product, item), category=g["category"].iloc[-1],
            usual_qty=max(1, int(round(float(g["qty"].median())))), provider=top,
            provider_confidence=round((providers.get(top, 0.0) if top else 0.0) * _evidence(n_evidence), 3),
            providers=providers, times_ordered=int(len(g)),
            typical_gap_days=round(float(np.median(gaps)), 1) if len(gaps) else None,
            last_ordered_days_ago=int((now - g["timestamp"].max()).days),
            typical_price=round(float(prices.median()), 2) if len(prices) else None, last_price=last_price,
            restaurant=restaurant, rejected_providers=rejected)

    by_cat: dict[str, Counter] = defaultdict(Counter)
    for p in items.values():
        if p.provider and p.category != RESTAURANT_FOOD:
            by_cat[p.category][p.provider] += p.times_ordered
    price_w, speed_w, conf, n = learn_weights(decisions)
    return ShoppingPreferences(items=items, price_weight=price_w, speed_weight=speed_w, weights_confidence=conf,
                               decisions=n, provider_by_category={c: v.most_common(1)[0][0] for c, v in by_cat.items()})
