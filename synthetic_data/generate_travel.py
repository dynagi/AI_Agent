"""
Synthetic TRAVEL behaviour generator for the AURA personal-prediction models.

Pipeline:  user profile -> persistent preferences -> trip process -> planning
sessions (search/view/price_check/wishlist/booking/cancel) -> events ->
leakage-free monthly snapshots (features + future targets) -> chronological split.

Everything is synthetic. No real people, names, contacts or payment data.

Usage:
    python generate_travel.py                 # seed 42
    python generate_travel.py --seed 7 --users 5000
    python generate_travel.py --seed 7 --start 2023-01-01 --out experiments/seed7_long   # ~3.7 years of history
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
RANDOM_SEED = 42
N_USERS = 5000
START_DATE = pd.Timestamp("2025-01-01")
END_DATE = pd.Timestamp("2026-09-01")
OUT_DIR = Path(__file__).resolve().parent

APPS = ["MakeMyTrip", "Booking.com", "Airbnb", "Goibibo", "Cleartrip", "IRCTC"]
ACTIONS = ["search", "flight_view", "hotel_view", "price_check", "wishlist", "booking", "cancel"]
TRAVEL_TYPES = ["business", "leisure", "family", "solo", "weekend", "holiday"]
BOOKING_TYPES = ["flight+hotel", "train+hotel", "flight", "train", "hotel"]

PERSONAS = {
    # share, trips/yr, gamma regularity k, lead-time mean (days), price-check rate
    "business_traveler": dict(share=0.12, trips=10.0, k=3.5, lead=7, pc=0.6),
    "frequent_traveler": dict(share=0.10, trips=9.0, k=2.5, lead=15, pc=1.0),
    "budget_traveler":   dict(share=0.20, trips=3.0, k=1.8, lead=25, pc=3.0),
    "luxury_traveler":   dict(share=0.08, trips=4.0, k=2.0, lead=40, pc=0.3),
    "weekend_traveler":  dict(share=0.15, trips=6.0, k=2.5, lead=10, pc=1.2),
    "family_traveler":   dict(share=0.18, trips=2.5, k=1.8, lead=45, pc=1.8),
    "solo_traveler":     dict(share=0.17, trips=4.0, k=2.0, lead=18, pc=1.5),
}

APP_BASE = {  # MakeMyTrip, Booking.com, Airbnb, Goibibo, Cleartrip, IRCTC
    "business_traveler": [.45, .10, .02, .13, .28, .02],
    "frequent_traveler": [.35, .15, .08, .17, .18, .07],
    "budget_traveler":   [.15, .05, .08, .25, .12, .35],
    "luxury_traveler":   [.30, .35, .25, .03, .05, .02],
    "weekend_traveler":  [.22, .20, .25, .15, .08, .10],
    "family_traveler":   [.35, .12, .05, .20, .08, .20],
    "solo_traveler":     [.15, .18, .40, .10, .07, .10],
}

TRAVEL_TYPE_W = {
    "business_traveler": {"business": .80, "leisure": .10, "family": .10},
    "frequent_traveler": {"business": .35, "leisure": .35, "weekend": .15, "solo": .15},
    "budget_traveler":   {"leisure": .40, "solo": .25, "family": .20, "weekend": .15},
    "luxury_traveler":   {"leisure": .60, "family": .25, "solo": .15},
    "weekend_traveler":  {"weekend": .75, "leisure": .15, "solo": .10},
    "family_traveler":   {"family": .75, "leisure": .25},
    "solo_traveler":     {"solo": .70, "leisure": .20, "weekend": .10},
}

HOTEL_MULT = {"business_traveler": 1.4, "frequent_traveler": 1.1, "budget_traveler": 0.45,
              "luxury_traveler": 3.0, "weekend_traveler": 1.0, "family_traveler": 1.1,
              "solo_traveler": 0.55}
FLIGHT_MULT = {"business_traveler": 1.25, "frequent_traveler": 1.05, "budget_traveler": 0.9,
               "luxury_traveler": 2.2, "weekend_traveler": 1.0, "family_traveler": 1.0,
               "solo_traveler": 0.95}
TRAIN_RATE = {"business_traveler": 2.2, "frequent_traveler": 2.2, "budget_traveler": 0.9,
              "luxury_traveler": 3.5, "weekend_traveler": 1.9, "family_traveler": 1.9,
              "solo_traveler": 1.2}  # INR per km per person
PEAK_HOUR = {"business_traveler": 21, "frequent_traveler": 20, "budget_traveler": 22,
             "luxury_traveler": 20, "weekend_traveler": 21, "family_traveler": 21,
             "solo_traveler": 23}
DEVICE_W = {"business_traveler": [.45, .50, .05]}  # mobile, desktop, tablet
DEVICE_DEFAULT = [.78, .17, .05]

# city: (lat, lon, kind, hotel_base_per_night, international)
CITIES = {
    "Mumbai": (19.08, 72.88, "metro", 5000, False),
    "Delhi": (28.61, 77.21, "metro", 4800, False),
    "Bangalore": (12.97, 77.59, "metro", 4500, False),
    "Hyderabad": (17.39, 78.49, "metro", 4000, False),
    "Chennai": (13.08, 80.27, "metro", 3800, False),
    "Pune": (18.52, 73.86, "metro", 3800, False),
    "Kolkata": (22.57, 88.36, "metro", 3500, False),
    "Ahmedabad": (23.02, 72.57, "metro", 3300, False),
    "Jaipur": (26.91, 75.79, "heritage", 3800, False),
    "Kochi": (9.93, 76.27, "beach", 3500, False),
    "Lucknow": (26.85, 80.95, "metro", 3000, False),
    "Chandigarh": (30.73, 76.78, "metro", 3200, False),
    "Goa": (15.49, 73.83, "beach", 4500, False),
    "Manali": (32.24, 77.19, "hill", 3200, False),
    "Shimla": (31.10, 77.17, "hill", 3300, False),
    "Udaipur": (24.58, 73.71, "heritage", 5000, False),
    "Munnar": (10.09, 77.06, "hill", 3500, False),
    "Rishikesh": (30.09, 78.27, "spiritual", 2200, False),
    "Varanasi": (25.32, 82.97, "spiritual", 2200, False),
    "Leh": (34.15, 77.58, "hill", 3800, False),
    "Darjeeling": (27.04, 88.26, "hill", 3000, False),
    "Port Blair": (11.62, 92.73, "beach", 5500, False),
    "Pondicherry": (11.94, 79.81, "beach", 3200, False),
    "Coorg": (12.34, 75.81, "hill", 4000, False),
    "Lonavala": (18.75, 73.41, "hill", 3500, False),
    "Mysore": (12.30, 76.64, "heritage", 2800, False),
    "Amritsar": (31.63, 74.87, "spiritual", 2600, False),
    "Agra": (27.18, 78.01, "heritage", 3000, False),
    "Ooty": (11.41, 76.70, "hill", 3200, False),
    "Mahabaleshwar": (17.92, 73.66, "hill", 3400, False),
    "Dubai": (25.20, 55.27, "international", 9000, True),
    "Singapore": (1.35, 103.82, "international", 11000, True),
    "Bangkok": (13.76, 100.50, "international", 4000, True),
    "Bali": (-8.34, 115.09, "international", 6000, True),
    "Maldives": (4.18, 73.51, "international", 25000, True),
    "London": (51.51, -0.13, "international", 14000, True),
    "Paris": (48.86, 2.35, "international", 15000, True),
}
CITY_NAMES = list(CITIES)

HOME_CITIES = {"Mumbai": .18, "Delhi": .18, "Bangalore": .15, "Hyderabad": .09, "Chennai": .08,
               "Pune": .08, "Kolkata": .07, "Ahmedabad": .06, "Jaipur": .03, "Kochi": .03,
               "Lucknow": .03, "Chandigarh": .02}
METROS = [c for c, v in CITIES.items() if v[2] == "metro"]
LEISURE = [c for c, v in CITIES.items() if v[2] in ("beach", "hill", "heritage", "spiritual") ]
INTL = [c for c, v in CITIES.items() if v[4]]

PERSONA_POOL = {
    "business_traveler": METROS,
    "frequent_traveler": METROS + LEISURE + ["Dubai", "Singapore", "Bangkok"],
    "budget_traveler": [c for c in LEISURE if CITIES[c][3] <= 3800] + ["Varanasi", "Amritsar"],
    "luxury_traveler": INTL + ["Goa", "Udaipur", "Port Blair", "Leh", "Coorg", "Jaipur"],
    "weekend_traveler": LEISURE,  # filtered by distance per user
    "family_traveler": LEISURE + METROS,
    "solo_traveler": ["Manali", "Rishikesh", "Leh", "Goa", "Pondicherry", "Darjeeling", "Varanasi",
                      "Bali", "Bangkok", "Coorg", "Udaipur", "Munnar"],
}

# India-centric holiday windows (travel/departure periods)
HOLIDAYS = [
    ("2025-01-01", "2025-01-05"), ("2025-01-24", "2025-01-27"), ("2025-03-13", "2025-03-16"),
    ("2025-05-01", "2025-06-15"), ("2025-08-14", "2025-08-17"), ("2025-10-01", "2025-10-05"),
    ("2025-10-17", "2025-10-26"), ("2025-12-20", "2026-01-04"), ("2026-01-23", "2026-01-26"),
    ("2026-03-03", "2026-03-08"), ("2026-05-01", "2026-06-15"), ("2026-08-14", "2026-08-17"),
    ("2026-10-17", "2026-10-21"), ("2026-11-05", "2026-11-12"), ("2026-12-19", "2027-01-03"),
]


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def haversine_km(a: str, b: str) -> float:
    la1, lo1 = np.radians(CITIES[a][:2])
    la2, lo2 = np.radians(CITIES[b][:2])
    h = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    return float(6371 * 2 * np.arcsin(np.sqrt(h)))


def build_calendar(start: pd.Timestamp, end: pd.Timestamp) -> tuple[pd.DatetimeIndex, np.ndarray]:
    days = pd.date_range(start, end, freq="D")
    hol = np.zeros(len(days), dtype=bool)
    windows = [(pd.Timestamp(a), pd.Timestamp(b)) for a, b in HOLIDAYS]
    # years before 2025 (--start earlier) reuse the 2025 windows shifted back a year at a time
    base = [w for w in windows if w[0].year == 2025]
    for back in range(1, 2025 - start.year + 1):
        windows += [(a - pd.DateOffset(years=back), b - pd.DateOffset(years=back)) for a, b in base]
    for a, b in windows:
        hol |= (days >= a) & (days <= b)
    return days, hol


def season_multiplier(dest: str, month: int) -> float:
    kind = CITIES[dest][2]
    if dest == "Leh":
        return 1.8 if 5 <= month <= 9 else 0.05
    if kind == "beach":
        return 0.35 if 6 <= month <= 9 else (1.6 if month in (11, 12, 1, 2) else 1.0)
    if kind == "hill":
        return 1.7 if 4 <= month <= 6 else (1.2 if month in (10, 12) else 0.8)
    if kind == "heritage":
        return 1.4 if month in (10, 11, 12, 1, 2) else (0.6 if 4 <= month <= 6 else 1.0)
    if kind == "international":
        return 1.3 if month in (5, 6, 12) else 1.0
    return 1.0


def weighted_choice(rng, items, weights):
    w = np.asarray(weights, dtype=float)
    return items[rng.choice(len(items), p=w / w.sum())]


# ----------------------------------------------------------------------------
# Users
# ----------------------------------------------------------------------------
def make_users(rng, n_users: int) -> list[dict]:
    names = list(PERSONAS)
    shares = np.array([PERSONAS[p]["share"] for p in names])
    homes, home_w = list(HOME_CITIES), np.array(list(HOME_CITIES.values()))
    users = []
    for i in range(n_users):
        persona = names[rng.choice(len(names), p=shares)]
        cfg = PERSONAS[persona]
        home = homes[rng.choice(len(homes), p=home_w / home_w.sum())]

        base = np.array(APP_BASE[persona])
        app_w = rng.dirichlet(base * 10 + 0.05)
        if rng.random() < 0.4:  # strong single-app loyalty
            app_w[rng.choice(len(APPS), p=app_w)] *= 3
        app_w /= app_w.sum()

        pool = [c for c in PERSONA_POOL[persona] if c != home]
        if persona == "weekend_traveler":
            near = sorted(pool, key=lambda c: haversine_km(home, c))
            pool = [c for c in near if haversine_km(home, c) < 650] or near[:4]
            pool = pool if len(pool) >= 3 else near[:4]
        n_fav = int(min(len(pool), rng.integers(2, 6)))
        favs = list(rng.choice(pool, size=n_fav, replace=False))
        fav_w = np.sort(rng.dirichlet(np.full(n_fav, 0.7)))[::-1]  # one dominant route

        hometown = None
        if persona in ("family_traveler", "budget_traveler") or rng.random() < 0.15:
            hometown = str(rng.choice([c for c in METROS + ["Varanasi", "Amritsar", "Kochi", "Jaipur"] if c != home]))

        trips = float(np.clip(cfg["trips"] * rng.lognormal(0, 0.35), 1.0, 30.0))
        users.append(dict(
            user_id=f"USER_{i + 1:06d}", persona=persona, home_city=home,
            app_weights=app_w, fav_destinations=favs, fav_weights=fav_w, pool=pool,
            hometown=hometown, trips_per_year=trips,
            regularity_k=float(np.clip(cfg["k"] * rng.lognormal(0, 0.2), 1.2, 6)),
            lead_mean=float(cfg["lead"] * rng.lognormal(0, 0.25)),
            price_check_rate=float(cfg["pc"] * rng.lognormal(0, 0.3)),
            explore_prob=float(np.clip(rng.beta(2, 7) + (0.15 if persona == "frequent_traveler" else 0), 0.03, 0.6)),
            peak_hour=float((PEAK_HOUR[persona] + rng.normal(0, 1.5)) % 24),
            price_mult=float(rng.lognormal(0, 0.12)),
            device_w=np.array(DEVICE_W.get(persona, DEVICE_DEFAULT)),
            age_group=weighted_choice(rng, ["18-24", "25-34", "35-44", "45-54", "55+"],
                                      {"solo_traveler": [.35, .45, .12, .05, .03],
                                       "budget_traveler": [.35, .35, .15, .10, .05],
                                       "family_traveler": [.02, .30, .45, .18, .05],
                                       "business_traveler": [.02, .40, .38, .17, .03],
                                       "luxury_traveler": [.02, .20, .35, .28, .15]}.get(persona, [.15, .40, .25, .12, .08])),
            income_band=weighted_choice(rng, ["low", "middle", "upper_middle", "high"],
                                        {"budget_traveler": [.45, .45, .08, .02],
                                         "luxury_traveler": [0, .05, .35, .60],
                                         "business_traveler": [0, .25, .50, .25],
                                         "solo_traveler": [.25, .50, .20, .05]}.get(persona, [.10, .45, .35, .10])),
        ))
    return users


# ----------------------------------------------------------------------------
# Trips and sessions
# ----------------------------------------------------------------------------
def departure_times(rng, u, days, hol) -> list[pd.Timestamp]:
    """Gamma renewal process in seasonally-rescaled time -> regular but imperfect trips."""
    persona = u["persona"]
    months = days.month.values
    dow = days.dayofweek.values
    inten = np.ones(len(days))
    if persona == "family_traveler":
        inten *= np.where(hol, 4.0, 0.6)
    elif persona == "business_traveler":
        inten *= np.where(hol, 0.3, 1.0)
        inten *= np.where(dow < 4, 1.3, 0.35)
    else:
        inten *= np.where(hol, 1.8, 1.0)
        inten *= np.where((months >= 7) & (months <= 9), 0.85, 1.0)
    if persona == "weekend_traveler":
        inten *= np.where(dow >= 4, 2.5, 0.25)
    inten = inten / inten.mean() * (u["trips_per_year"] / 365.0)
    cum = np.cumsum(inten)
    k = u["regularity_k"]
    t = rng.gamma(k, 1 / k) * rng.random()
    out = []
    while True:
        t += rng.gamma(k, 1 / k)
        if t >= cum[-1]:
            break
        idx = int(np.searchsorted(cum, t))
        out.append(days[idx])
    return out


def choose_destination(rng, u, month: int) -> tuple[str, bool]:
    if u["hometown"] and u["persona"] in ("family_traveler", "budget_traveler") and rng.random() < 0.28:
        return u["hometown"], True
    if rng.random() < u["explore_prob"]:
        pool = u["pool"]
        w = [season_multiplier(c, month) for c in pool]
        return weighted_choice(rng, pool, w), False
    favs = u["fav_destinations"]
    w = u["fav_weights"] * np.array([season_multiplier(c, month) for c in favs]) ** 0.6
    return weighted_choice(rng, favs, w), False


def plan_trip(rng, u, dep_day: pd.Timestamp, hol_set: set) -> dict | None:
    persona = u["persona"]
    dest, is_hometown = choose_destination(rng, u, dep_day.month)
    origin = u["home_city"]
    if dest == origin:
        return None
    km = haversine_km(origin, dest)
    intl = CITIES[dest][4]
    is_hol = dep_day.normalize() in hol_set

    tt_w = TRAVEL_TYPE_W[persona]
    ttype = weighted_choice(rng, list(tt_w), list(tt_w.values()))
    if is_hometown:
        ttype = "family"
    elif ttype == "leisure" and is_hol:
        ttype = "holiday"
    if ttype == "business" and CITIES[dest][2] != "metro":
        ttype = "leisure"

    dur_params = {"business": (2.5, 0.8), "weekend": (6, 0.4), "family": (4, 1.6), "leisure": (3, 1.5),
                  "solo": (2.5, 2.4), "holiday": (3.5, 1.8)}
    shape, scale = dur_params[ttype]
    duration = int(np.clip(round(rng.gamma(shape, scale)), 1, 21))
    if ttype == "weekend":
        duration = int(np.clip(duration, 1, 3))
    if ttype == "business":
        duration = int(np.clip(duration, 1, 5))
    if intl:
        duration = int(np.clip(duration + rng.integers(1, 4), 3, 21))
    if is_hometown:
        duration = int(np.clip(duration + rng.integers(2, 7), 3, 21))

    travelers = {"family": int(rng.integers(3, 6)), "solo": 1, "business": 1}.get(
        ttype, int(rng.choice([1, 2, 2, 3])) if persona != "solo_traveler" else 1)

    # transport mode
    if intl:
        mode = "flight"
    elif km < 250:
        mode = "road" if rng.random() < 0.6 else "train"
    else:
        p_train = {"budget_traveler": .7, "family_traveler": .45, "luxury_traveler": .02,
                   "business_traveler": .08}.get(persona, .22)
        if km > 900:
            p_train *= 0.45
        mode = "train" if rng.random() < p_train else "flight"
    need_hotel = rng.random() < ({"business": .85, "family": .55}.get(ttype, .92)) * (0.6 if persona == "budget_traveler" else 1.0)
    if is_hometown:
        need_hotel = rng.random() < 0.08
    if mode == "road":
        need_hotel = True
    booking_type = {("flight", True): "flight+hotel", ("train", True): "train+hotel",
                    ("flight", False): "flight", ("train", False): "train",
                    ("road", True): "hotel"}[(mode, need_hotel)]

    # weekday alignment
    if ttype == "business" and dep_day.dayofweek >= 4:
        dep_day = dep_day - pd.Timedelta(days=int(dep_day.dayofweek - rng.integers(0, 4)))
    if ttype == "weekend" and dep_day.dayofweek < 4:
        dep_day = dep_day + pd.Timedelta(days=int(4 - dep_day.dayofweek + rng.integers(0, 2)))

    lead = max(0.2, rng.gamma(2.0, u["lead_mean"] / 2.0))
    if is_hol and persona in ("family_traveler", "luxury_traveler"):
        lead *= 1.4
    lead = float(min(lead, 150))

    # pricing (INR)
    lead_f = 1.6 if lead < 3 else 1.35 if lead < 7 else 1.15 if lead < 14 else 1.0 if lead < 60 else 0.95
    hol_f = 1.3 if is_hol else 1.0
    pm = u["price_mult"]
    flight_pp = 0.0
    train_pp = 0.0
    if mode == "flight":
        base = (6000 + 5.5 * km) if intl else (1800 + 3.2 * km)
        flight_pp = base * lead_f * hol_f * FLIGHT_MULT[persona] * pm * rng.lognormal(0, 0.15)
    elif mode == "train":
        train_pp = max(180.0, km * TRAIN_RATE[persona] * pm * rng.lognormal(0, 0.12)) * (1.1 if is_hol else 1.0)
    hotel_night = 0.0
    if need_hotel:
        hotel_night = CITIES[dest][3] * HOTEL_MULT[persona] * pm * hol_f * season_multiplier(dest, dep_day.month) ** 0.3 \
            * rng.lognormal(0, 0.25)
    rooms = int(np.ceil(travelers / 2)) if ttype != "family" else int(np.clip(travelers // 2, 1, 3))
    nights = max(1, duration)

    return dict(origin=origin, destination=dest, km=km, intl=intl, travel_type=ttype,
                trip_duration_days=duration, travelers=travelers, mode=mode, booking_type=booking_type,
                departure=dep_day, lead_days=lead, is_holiday_period=is_hol,
                transport_quote=(flight_pp + train_pp) * travelers,
                hotel_quote=hotel_night * nights * rooms)


COMPATIBLE_APPS = {
    "train": ["IRCTC", "MakeMyTrip", "Goibibo", "Cleartrip"],
    "flight": ["MakeMyTrip", "Goibibo", "Cleartrip"],
    "hotel": ["Booking.com", "Airbnb", "MakeMyTrip", "Goibibo"],
    "flight+hotel": ["MakeMyTrip", "Goibibo", "Cleartrip", "Booking.com"],
    "train+hotel": ["MakeMyTrip", "Goibibo"],
}


def sample_hour(rng, u) -> int:
    if rng.random() < 0.25:
        return int(rng.integers(7, 24))
    return int(round(rng.normal(u["peak_hour"], 2.2))) % 24


def session_events(rng, u, trip: dict, trip_id: str, booked: bool, start: pd.Timestamp,
                   end: pd.Timestamp) -> list[dict]:
    persona = u["persona"]
    dep = trip["departure"] + pd.Timedelta(hours=int(rng.integers(5, 22)))
    booking_ts = dep - pd.Timedelta(days=trip["lead_days"])
    booking_ts = booking_ts.normalize() + pd.Timedelta(hours=sample_hour(rng, u),
                                                       minutes=int(rng.integers(0, 60)),
                                                       seconds=int(rng.integers(0, 60)))
    if booking_ts >= dep:
        booking_ts = dep - pd.Timedelta(hours=int(rng.integers(3, 12)))
    plan_days = {"business_traveler": 2, "weekend_traveler": 4, "family_traveler": 14,
                 "luxury_traveler": 10}.get(persona, 7)
    span = float(min(rng.gamma(1.5, plan_days / 1.5), 45))

    has_f = trip["mode"] == "flight"
    has_h = trip["booking_type"] in ("flight+hotel", "train+hotel", "hotel")
    seq = ["search"] * int(1 + rng.poisson(1.3 if persona != "budget_traveler" else 2.2))
    seq += ["flight_view"] * int(rng.poisson(1.6)) if has_f else []
    seq += ["hotel_view"] * int(rng.poisson(1.8 if persona != "luxury_traveler" else 1.0)) if has_h else []
    seq += ["price_check"] * int(rng.poisson(u["price_check_rate"]))
    if rng.random() < (0.35 if persona in ("family_traveler", "luxury_traveler", "solo_traveler") else 0.15):
        seq.append("wishlist")
    head, rest = seq[0], seq[1:]
    rng.shuffle(rest)
    seq = [head] + rest
    if not booked:
        seq = seq[: max(1, int(rng.integers(1, len(seq) + 1)))]

    n = len(seq)
    offsets = np.sort(rng.random(n))[::-1] * span  # days before booking_ts
    times = []
    for off in offsets:
        day = (booking_ts - pd.Timedelta(days=float(off))).normalize()
        t = day + pd.Timedelta(hours=sample_hour(rng, u), minutes=int(rng.integers(0, 60)),
                               seconds=int(rng.integers(0, 60)))
        times.append(min(t, booking_ts - pd.Timedelta(minutes=int(rng.integers(2, 90)))))
    times = sorted(times)
    if booked:
        seq.append("booking")
        times.append(booking_ts)
        if rng.random() < (0.08 if persona == "business_traveler" else 0.045):
            gap = (dep - booking_ts).total_seconds()
            if gap > 6 * 3600:
                times.append(booking_ts + pd.Timedelta(seconds=float(rng.uniform(0.1, 0.8)) * gap))
                seq.append("cancel")

    if times[0] < start or times[-1] > end:
        return []

    # browsing apps: mostly preferred apps; booking app must sell the booked product
    app_w = u["app_weights"]
    compat = COMPATIBLE_APPS[trip["booking_type"]]
    cw = np.array([app_w[APPS.index(a)] for a in compat]) + 1e-3
    book_app = compat[rng.choice(len(compat), p=cw / cw.sum())]
    device = ["mobile", "desktop", "tablet"][rng.choice(3, p=u["device_w"])]

    rows = []
    counts = Counter()
    for action, ts in zip(seq, times):
        counts[action] += 1
        if action in ("booking", "cancel"):
            app = book_app
        elif action == "flight_view" or rng.random() < 0.55:
            app = book_app if action != "hotel_view" or book_app in COMPATIBLE_APPS["hotel"] \
                else APPS[rng.choice(len(APPS), p=app_w)]
        else:
            app = APPS[rng.choice(len(APPS), p=app_w)]
        if action == "flight_view" and app in ("Airbnb", "Booking.com", "IRCTC"):
            app = book_app if book_app in COMPATIBLE_APPS["flight"] else "MakeMyTrip"
        # quotes drift over the planning window
        drift = rng.lognormal(0, 0.05)
        tq = trip["transport_quote"] * drift
        hq = trip["hotel_quote"] * rng.lognormal(0, 0.05)
        fprice = tq if trip["mode"] == "flight" else 0.0
        tprice = tq if trip["mode"] == "train" else 0.0
        amount = 0.0
        if action in ("booking", "cancel"):
            fprice, tprice, hq = trip["_booked_f"], trip["_booked_t"], trip["_booked_h"]
            amount = fprice + tprice + hq
        rows.append(dict(
            user_id=u["user_id"], timestamp=ts, app=app, action=action, trip_id=trip_id,
            origin=trip["origin"], destination=trip["destination"],
            is_international=trip["intl"], distance_km=round(trip["km"], 1),
            travel_type=trip["travel_type"], booking_type=trip["booking_type"],
            transport_mode=trip["mode"], num_travelers=trip["travelers"],
            trip_duration_days=trip["trip_duration_days"],
            departure_date=trip["departure"].date().isoformat(),
            flight_price=round(fprice), train_price=round(tprice), hotel_price=round(hq),
            booking_amount=round(amount),
            search_count=counts["search"], flight_view=counts["flight_view"],
            hotel_view=counts["hotel_view"], price_check=counts["price_check"],
            travel_month=int(trip["departure"].month),
            is_holiday_period=bool(trip["is_holiday_period"]), device=device,
        ))
    return rows


def generate_events(rng, users, start, end) -> pd.DataFrame:
    days, hol = build_calendar(start, end + pd.Timedelta(days=150))
    hol_set = set(days[hol])
    rows = []
    trip_no = 0
    for u in users:
        for dep in departure_times(rng, u, days, hol):
            trip = plan_trip(rng, u, dep, hol_set)
            if trip is None:
                continue
            trip["_booked_f"] = round(trip["transport_quote"]) if trip["mode"] == "flight" else 0
            trip["_booked_t"] = round(trip["transport_quote"]) if trip["mode"] == "train" else 0
            trip["_booked_h"] = round(trip["hotel_quote"])
            trip_no += 1
            rows += session_events(rng, u, trip, f"TRIP_{trip_no:07d}", True, start, end)
            # abandoned exploration sessions (searched, never booked)
            if rng.random() < 0.28:
                alt = plan_trip(rng, u, dep + pd.Timedelta(days=int(rng.integers(-20, 20))), hol_set)
                if alt is not None:
                    alt["_booked_f"] = alt["_booked_t"] = alt["_booked_h"] = 0
                    trip_no += 1
                    rows += session_events(rng, u, alt, f"TRIP_{trip_no:07d}", False, start, end)
    df = pd.DataFrame(rows)

    # guarantee strictly increasing timestamps per user (unique user+timestamp+action+destination)
    df = df.sort_values(["user_id", "timestamp", "trip_id"], kind="mergesort").reset_index(drop=True)
    ts = df["timestamp"].values.astype("datetime64[s]").astype(np.int64)
    uid = df["user_id"].values
    for i in range(1, len(ts)):
        if uid[i] == uid[i - 1] and ts[i] <= ts[i - 1]:
            ts[i] = ts[i - 1] + 1
    df["timestamp"] = pd.to_datetime(ts, unit="s")

    df = df.sort_values(["timestamp", "user_id"], kind="mergesort").reset_index(drop=True)
    df.insert(0, "event_id", [f"TRV_EVT_{i + 1:08d}" for i in range(len(df))])
    df["day_of_week"] = df["timestamp"].dt.day_name()
    df["hour"] = df["timestamp"].dt.hour
    df["is_weekend"] = df["timestamp"].dt.dayofweek >= 5
    df["currency"] = "INR"
    df["synthetic"] = True
    return df


# ----------------------------------------------------------------------------
# Feature snapshots (leakage-free)
# ----------------------------------------------------------------------------
def _mode(values, default="none"):
    if len(values) == 0:
        return default, 0.0
    c = Counter(values).most_common(1)[0]
    return c[0], c[1] / len(values)


def build_features(rng, events: pd.DataFrame, start, end, hol_days: np.ndarray) -> pd.DataFrame:
    """One snapshot per user per month at a random moment. Features use events strictly
    before snapshot_timestamp; targets describe the first booking strictly after it."""
    hol_days = np.sort(hol_days.astype("datetime64[D]"))
    months = pd.date_range(start + pd.offsets.MonthBegin(1), end, freq="MS")
    out = []
    for uid, g in events.groupby("user_id", sort=True):
        t = g["timestamp"].values
        act = g["action"].to_numpy(dtype=object)
        is_b = act == "booking"
        if is_b.sum() < 2:
            continue
        b_idx = np.flatnonzero(is_b)
        b_t = t[b_idx]
        app = g["app"].to_numpy(dtype=object)
        dest = g["destination"].to_numpy(dtype=object)
        ttype = g["travel_type"].to_numpy(dtype=object)
        btype = g["booking_type"].to_numpy(dtype=object)
        amt = g["booking_amount"].values.astype(float)
        dur = g["trip_duration_days"].values
        fprice = g["flight_price"].values.astype(float)
        hprice = g["hotel_price"].values.astype(float)
        intl = g["is_international"].values
        trip = g["trip_id"].to_numpy(dtype=object)
        dep = pd.to_datetime(g["departure_date"]).values
        hours = g["hour"].values
        dows = g["timestamp"].dt.dayofweek.values
        origin = g["origin"].iloc[0]

        for m in months:
            snap = m + pd.Timedelta(days=int(rng.integers(0, 28)), hours=int(rng.integers(0, 24)),
                                    minutes=int(rng.integers(0, 60)))
            snap += pd.Timedelta(seconds=int(rng.integers(0, 60)))
            snap64 = np.datetime64(snap, "ns")
            while (t == snap64).any():  # never let an event coincide with the snapshot
                snap += pd.Timedelta(seconds=1)
                snap64 = np.datetime64(snap, "ns")
            n_prior = int(np.searchsorted(t, snap64, side="left"))  # events strictly before
            pb = b_idx[b_idx < n_prior]
            nb = b_idx[b_idx >= n_prior]
            if len(pb) == 0 or len(nb) == 0:
                continue
            nxt = nb[0]
            day = np.timedelta64(1, "D")

            pt = t[:n_prior]
            pbt = t[pb]
            pamt = amt[pb]
            gaps = np.diff(pbt) / day if len(pb) > 1 else np.array([])
            last_b = pb[-1]
            in_7 = pt >= snap64 - 7 * day
            in_30 = pt >= snap64 - 30 * day
            in_90 = pt >= snap64 - 90 * day
            in_365 = pt >= snap64 - 365 * day
            b90 = pbt >= snap64 - 90 * day
            b365 = pbt >= snap64 - 365 * day
            searches = act[:n_prior] == "search"
            last_search = np.flatnonzero(searches)
            fv30 = (act[:n_prior] == "flight_view") & in_30 & (fprice[:n_prior] > 0)
            months_active = max(1.0, (snap64 - pt[0]) / day / 30.44)

            # current (post-last-booking) session activity
            cur = np.arange(last_b + 1, n_prior)
            cur_non_cancel = cur[act[cur] != "cancel"]
            p_dest, p_dest_share = _mode(list(dest[pb]))
            p_app, p_app_share = _mode(list(app[:n_prior]))
            b_app, _ = _mode(list(app[pb]))
            p_tt, _ = _mode(list(ttype[pb]))
            p_bt, _ = _mode(list(btype[pb]))
            ph, _ = _mode(list(hours[:n_prior]), 20)
            pd_, _ = _mode(list(dows[:n_prior]), 5)
            lead = (dep[pb] - pbt) / day
            n_cancel = int((act[:n_prior] == "cancel").sum())
            dest_counts = Counter(dest[pb])
            future_hol = hol_days[hol_days >= np.datetime64(snap.normalize(), "D")]

            out.append(dict(
                user_id=uid, snapshot_timestamp=snap, home_city=origin,
                snapshot_month=snap.month, snapshot_day_of_week=snap.dayofweek,
                snapshot_is_weekend=snap.dayofweek >= 5,
                days_to_next_holiday_period=int((future_hol[0] - np.datetime64(snap.normalize(), "D")) / np.timedelta64(1, "D")) if len(future_hol) else 365,
                # recency
                days_since_last_event=round(float((snap64 - pt[-1]) / day), 5),
                days_since_last_booking=round(float((snap64 - t[last_b]) / day), 3),
                days_since_last_search=round(float((snap64 - pt[last_search[-1]]) / day), 3) if len(last_search) else -1.0,
                # frequency
                events_last_7_days=int(in_7.sum()), events_last_30_days=int(in_30.sum()),
                events_last_90_days=int(in_90.sum()), searches_last_30_days=int((searches & in_30).sum()),
                price_checks_last_30_days=int(((act[:n_prior] == "price_check") & in_30).sum()),
                bookings_last_90_days=int(b90.sum()), bookings_last_365_days=int(b365.sum()),
                total_bookings=int(len(pb)), monthly_booking_frequency=round(len(pb) / months_active, 4),
                # monetary
                average_booking_amount=round(float(pamt.mean()), 2),
                median_booking_amount=round(float(np.median(pamt)), 2),
                max_booking_amount=float(pamt.max()),
                total_spend_90_days=float(pamt[b90].sum()), total_spend_365_days=float(pamt[b365].sum()),
                avg_flight_price_viewed_30_days=round(float(fprice[:n_prior][fv30].mean()), 2) if fv30.any() else 0.0,
                # temporal
                preferred_hour=int(ph), preferred_day=int(pd_),
                weekend_ratio=round(float((dows[:n_prior] >= 5).mean()), 4),
                avg_lead_time_days=round(float(lead.mean()), 2),
                # preference
                preferred_app=p_app, preferred_app_share=round(p_app_share, 4),
                preferred_booking_app=b_app,
                preferred_destination=p_dest, preferred_destination_share=round(p_dest_share, 4),
                preferred_travel_type=p_tt, preferred_booking_type=p_bt,
                unique_destinations=int(len(dest_counts)),
                repeat_destination_ratio=round(1 - len(dest_counts) / len(pb), 4),
                international_ratio=round(float(intl[pb].mean()), 4),
                avg_trip_duration=round(float(dur[pb].mean()), 2),
                # behavioural
                average_days_between_bookings=round(float(gaps.mean()), 2) if len(gaps) else -1.0,
                std_days_between_bookings=round(float(gaps.std()), 2) if len(gaps) > 1 else -1.0,
                cancel_ratio=round(n_cancel / len(pb), 4),
                searches_per_booking=round(float(searches.sum()) / len(pb), 3),
                last_destination=dest[last_b], last_app=app[last_b], last_travel_type=ttype[last_b],
                last_booking_type=btype[last_b], last_trip_duration=int(dur[last_b]),
                last_booking_amount=float(amt[last_b]),
                # current planning activity since last booking (observable now)
                current_session_events=int(len(cur_non_cancel)),
                current_app=app[cur_non_cancel[-1]] if len(cur_non_cancel) else "none",
                current_search_destination=dest[cur_non_cancel[-1]] if len(cur_non_cancel) else "none",
                current_session_searches=int((act[cur_non_cancel] == "search").sum()),
                current_session_price_checks=int((act[cur_non_cancel] == "price_check").sum()),
                current_session_hotel_views=int((act[cur_non_cancel] == "hotel_view").sum()),
                current_session_flight_views=int((act[cur_non_cancel] == "flight_view").sum()),
                # ---- targets (future) ----
                next_destination=dest[nxt], next_app=app[nxt], next_travel_type=ttype[nxt],
                next_booking_type=btype[nxt],
                days_until_next_trip=round(float((t[nxt] - snap64) / day), 3),
                days_until_next_departure=round(float((dep[nxt] - snap64) / day), 3),
                expected_trip_duration=int(dur[nxt]), expected_booking_amount=float(amt[nxt]),
                target_timestamp=pd.Timestamp(t[nxt]),
            ))
    f = pd.DataFrame(out).sort_values(["snapshot_timestamp", "user_id"], kind="mergesort").reset_index(drop=True)

    # chronological 70/15/15 split on snapshot time
    q70, q85 = f["snapshot_timestamp"].quantile([0.70, 0.85])
    f["split"] = np.where(f["snapshot_timestamp"] <= q70, "train",
                          np.where(f["snapshot_timestamp"] <= q85, "validation", "test"))
    boundary = np.where(f["split"] == "train", q70, np.where(f["split"] == "validation", q85, pd.Timestamp.max))
    f["target_crosses_split"] = f["target_timestamp"].values > boundary.astype("datetime64[ns]")
    f.insert(0, "snapshot_id", [f"TRV_SNAP_{i + 1:07d}" for i in range(len(f))])
    f["synthetic"] = True
    return f


# ----------------------------------------------------------------------------
# Validation
# ----------------------------------------------------------------------------
def validate(events: pd.DataFrame, feats: pd.DataFrame, users: pd.DataFrame, start, end) -> dict:
    checks = {}
    checks["min_5000_event_rows"] = len(events) >= 5000
    checks["min_5000_feature_rows"] = len(feats) >= 5000
    checks["unique_event_ids"] = events["event_id"].is_unique
    checks["no_duplicate_event_rows"] = not events.duplicated().any()
    checks["no_duplicate_event_rows_ignoring_id"] = not events.drop(columns="event_id").duplicated().any()
    checks["no_duplicate_user_ts_action_dest"] = not events.duplicated(["user_id", "timestamp", "action", "destination"]).any()
    checks["unique_snapshot_ids"] = feats["snapshot_id"].is_unique
    checks["no_duplicate_feature_rows"] = not feats.duplicated().any()
    checks["no_null_user_ids"] = events["user_id"].notna().all() and feats["user_id"].notna().all()
    checks["no_nulls_events"] = int(events.isna().sum().sum()) == 0
    checks["no_nulls_features"] = int(feats.isna().sum().sum()) == 0
    checks["timestamps_in_range"] = bool(events["timestamp"].between(start, end).all())
    price_cols = ["flight_price", "train_price", "hotel_price", "booking_amount"]
    checks["no_negative_prices"] = bool((events[price_cols] >= 0).all().all())
    checks["valid_durations_travelers"] = bool((events["trip_duration_days"] >= 1).all() and (events["num_travelers"] >= 1).all())
    b = events[events["action"] == "booking"]
    checks["bookings_have_positive_amount"] = bool((b["booking_amount"] > 0).all())
    checks["departure_after_booking"] = bool((pd.to_datetime(b["departure_date"]) + pd.Timedelta(days=1) > b["timestamp"]).all())
    checks["valid_apps"] = set(events["app"]) <= set(APPS)
    checks["valid_actions"] = set(events["action"]) <= set(ACTIONS)
    checks["valid_travel_types"] = set(events["travel_type"]) <= set(TRAVEL_TYPES)
    checks["all_6_apps_used"] = events["app"].nunique() == len(APPS)
    checks["min_users_4000"] = events["user_id"].nunique() >= 4000
    checks["events_chronological"] = events["timestamp"].is_monotonic_increasing
    checks["features_chronological"] = feats["snapshot_timestamp"].is_monotonic_increasing
    checks["no_leakage_target_after_snapshot"] = bool((feats["target_timestamp"] > feats["snapshot_timestamp"]).all())
    checks["no_leakage_last_event_before_snapshot"] = bool((feats["days_since_last_event"] > 0).all())
    tr = feats.loc[feats.split == "train", "snapshot_timestamp"].max()
    va = feats.loc[feats.split == "validation", "snapshot_timestamp"]
    te = feats.loc[feats.split == "test", "snapshot_timestamp"].min()
    checks["split_is_chronological"] = bool(tr < va.min() and va.max() < te)
    checks["all_event_users_in_users_file"] = set(events["user_id"]) <= set(users["user_id"])
    return {k: bool(v) for k, v in checks.items()}


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=RANDOM_SEED)
    ap.add_argument("--users", type=int, default=N_USERS)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--start", type=pd.Timestamp, default=START_DATE, help="first event date (more history per user)")
    ap.add_argument("--end", type=pd.Timestamp, default=END_DATE)
    args = ap.parse_args()
    start, end = args.start, args.end

    rng = np.random.default_rng(args.seed)
    users = make_users(rng, args.users)
    events = generate_events(rng, users, start, end)

    days, hol = build_calendar(start, end + pd.Timedelta(days=400))
    feats = build_features(rng, events, start, end, days[hol].values)

    persona_counts = events.groupby("user_id").size()
    users_df = pd.DataFrame([dict(
        user_id=u["user_id"], persona=u["persona"], home_city=u["home_city"], age_group=u["age_group"],
        income_band=u["income_band"],
        preferred_app=APPS[int(np.argmax(u["app_weights"]))],
        **{f"app_share_{a.lower().replace('.', '_')}": round(float(w), 4) for a, w in zip(APPS, u["app_weights"])},
        favorite_destinations="|".join(u["fav_destinations"]),
        top_destination=u["fav_destinations"][0],
        hometown=u["hometown"] or "none",
        expected_trips_per_year=round(u["trips_per_year"], 2),
        trip_regularity_k=round(u["regularity_k"], 3),
        avg_booking_lead_days=round(u["lead_mean"], 2),
        price_sensitivity=round(u["price_check_rate"], 3),
        exploration_probability=round(u["explore_prob"], 3),
        peak_activity_hour=int(round(u["peak_hour"])) % 24,
        total_events=int(persona_counts.get(u["user_id"], 0)),
        synthetic=True,
    ) for u in users])

    checks = validate(events, feats, users_df, start, end)

    trav = args.out / "travel"
    meta = args.out / "metadata"
    trav.mkdir(parents=True, exist_ok=True)
    meta.mkdir(parents=True, exist_ok=True)
    assert events["event_id"].is_unique and not events.duplicated().any()
    events.to_csv(trav / "travel_events.csv", index=False)
    feats.to_csv(trav / "travel_features.csv", index=False)
    users_df.to_csv(trav / "travel_users.csv", index=False)

    target_cols = ["next_destination", "next_app", "next_travel_type", "next_booking_type",
                   "days_until_next_trip", "days_until_next_departure", "expected_trip_duration",
                   "expected_booking_amount"]
    non_feature = ["snapshot_id", "user_id", "snapshot_timestamp", "target_timestamp", "split",
                   "target_crosses_split", "synthetic"]
    disclaimer = dict(synthetic_data=True, real_person_data=False, generated_for="ML research and development")
    (meta / "schema.json").write_text(json.dumps(dict(
        **disclaimer,
        travel_events={c: str(t) for c, t in events.dtypes.items()},
        travel_features={c: str(t) for c, t in feats.dtypes.items()},
        travel_users={c: str(t) for c, t in users_df.dtypes.items()},
        feature_columns=[c for c in feats.columns if c not in target_cols + non_feature],
        target_columns=target_cols,
        non_feature_columns=non_feature,
        notes={
            "search_count/flight_view/hotel_view/price_check": "cumulative counts within the trip-planning session (trip_id) up to and including the row",
            "flight_price/train_price/hotel_price": "INR quotes for the trip being planned; 0 when that component is not part of the trip",
            "booking_amount": "INR total paid, only on booking/cancel rows, 0 otherwise",
            "travel_month/is_holiday_period": "refer to the trip's departure date",
            "features": "computed only from events strictly before snapshot_timestamp",
            "targets": "first booking strictly after snapshot_timestamp",
            "target_crosses_split": "True when the target booking falls after the split boundary; drop these rows for a strict purged evaluation",
        },
    ), indent=2), encoding="utf-8")
    (meta / "generation_config.json").write_text(json.dumps(dict(
        **disclaimer, domain="travel", random_seed=args.seed, n_users=args.users,
        start_date=str(start.date()), end_date=str(end.date()), apps=APPS, actions=ACTIONS,
        travel_types=TRAVEL_TYPES, booking_types=BOOKING_TYPES,
        personas={k: {kk: vv for kk, vv in v.items()} for k, v in PERSONAS.items()},
        split={"train": 0.70, "validation": 0.15, "test": 0.15, "method": "chronological on snapshot_timestamp"},
    ), indent=2), encoding="utf-8")
    stats = dict(
        **disclaimer,
        travel=dict(
            event_rows=len(events), feature_rows=len(feats), user_rows=len(users_df),
            users_with_events=int(events["user_id"].nunique()),
            users_with_features=int(feats["user_id"].nunique()),
            bookings=int((events.action == "booking").sum()),
            cancellations=int((events.action == "cancel").sum()),
            apps=events["app"].value_counts().to_dict(),
            actions=events["action"].value_counts().to_dict(),
            travel_types=events.loc[events.action == "booking", "travel_type"].value_counts().to_dict(),
            top_destinations=events.loc[events.action == "booking", "destination"].value_counts().head(15).to_dict(),
            personas=users_df["persona"].value_counts().to_dict(),
            split=feats["split"].value_counts().to_dict(),
            booking_amount_inr=events.loc[events.action == "booking", "booking_amount"].describe().round(1).to_dict(),
            validation_checks=checks,
        ),
    )
    (meta / "dataset_statistics.json").write_text(json.dumps(stats, indent=2, default=str), encoding="utf-8")

    line = "=" * 44
    print(f"{line}\nTRAVEL DATASET QUALITY REPORT\n{line}")
    print(f"Event rows:        {len(events):,}")
    print(f"Feature rows:      {len(feats):,}")
    print(f"Users (file):      {len(users_df):,}")
    print(f"Users w/ events:   {events['user_id'].nunique():,}")
    print(f"Bookings:          {stats['travel']['bookings']:,}")
    print(f"Apps:              {events['app'].nunique()}")
    print(f"Destinations:      {events['destination'].nunique()}")
    print(f"Duplicate rows:    {int(events.duplicated().sum())}")
    print(f"Duplicate IDs:     {int(events['event_id'].duplicated().sum())}")
    print(f"Nulls (events):    {int(events.isna().sum().sum())}")
    print(f"Nulls (features):  {int(feats.isna().sum().sum())}")
    print(f"Split:             {feats['split'].value_counts().reindex(['train', 'validation', 'test']).to_dict()}")
    print(line)
    for k, v in checks.items():
        print(f"{'PASS' if v else 'FAIL'}  {k}")
    print(line)
    if not all(checks.values()):
        raise SystemExit("Validation failed")


if __name__ == "__main__":
    main()
