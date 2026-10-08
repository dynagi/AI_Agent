"""Turns one user's raw travel events into the feature row the travel model was trained on.

Mirrors synthetic_data/generate_travel.py::build_features (the 55 "v1" columns) and
synthetic_data/train_improved.py::add_v2_features (history/session/timing columns) for a
single snapshot time. Only events strictly before `as_of` are used. Any change here must keep
tests/test_travel_features_parity.py passing, or predictions silently drift from training.
"""
from __future__ import annotations

from collections import Counter

import numpy as np
import pandas as pd

TAU_DAYS = 90.0
DAY = np.timedelta64(1, "D")

EVENT_COLUMNS = ["timestamp", "app", "action", "origin", "destination", "is_international", "travel_type",
                 "booking_type", "trip_duration_days", "departure_date", "flight_price", "train_price",
                 "hotel_price", "booking_amount"]
ACTIONS = {"search", "flight_view", "hotel_view", "price_check", "wishlist", "booking", "cancel"}
INTERNATIONAL = {"Dubai", "Singapore", "Bangkok", "Bali", "Maldives", "London", "Paris"}

# Same holiday windows the generator used. Earlier years reuse the 2025 windows (generator --start),
# later years reuse the 2026 windows so serving past 2026 still sees upcoming holidays.
_HOLIDAYS = [
    ("2025-01-01", "2025-01-05"), ("2025-01-24", "2025-01-27"), ("2025-03-13", "2025-03-16"),
    ("2025-05-01", "2025-06-15"), ("2025-08-14", "2025-08-17"), ("2025-10-01", "2025-10-05"),
    ("2025-10-17", "2025-10-26"), ("2025-12-20", "2026-01-04"), ("2026-01-23", "2026-01-26"),
    ("2026-03-03", "2026-03-08"), ("2026-05-01", "2026-06-15"), ("2026-08-14", "2026-08-17"),
    ("2026-10-17", "2026-10-21"), ("2026-11-05", "2026-11-12"), ("2026-12-19", "2027-01-03"),
]


def _holiday_days() -> np.ndarray:
    windows = [(pd.Timestamp(a), pd.Timestamp(b)) for a, b in _HOLIDAYS]
    shifted = []
    for back in range(1, 6):
        shifted += [(a - pd.DateOffset(years=back), b - pd.DateOffset(years=back)) for a, b in windows if a.year == 2025]
    for fwd in range(1, 6):
        shifted += [(a + pd.DateOffset(years=fwd), b + pd.DateOffset(years=fwd)) for a, b in windows if a.year == 2026]
    days = set()
    for a, b in windows + shifted:
        days.update(pd.date_range(a, b, freq="D"))
    return np.array(sorted(days), dtype="datetime64[D]")


HOLIDAY_DAYS = _holiday_days()


def normalize_events(events: pd.DataFrame | list[dict]) -> pd.DataFrame:
    """Coerces events from any source (CSV, Supabase JSON, API payload) into the training schema."""
    df = pd.DataFrame(events).copy()
    for c in EVENT_COLUMNS:
        if c not in df:
            df[c] = None
    df["timestamp"] = _to_india_naive(df["timestamp"])
    df["departure_date"] = _to_india_naive(df["departure_date"]).dt.normalize()
    for c in ["trip_duration_days", "flight_price", "train_price", "hotel_price", "booking_amount"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    df["is_international"] = df["is_international"].where(df["is_international"].notna(),
                                                          df["destination"].isin(INTERNATIONAL))
    df["is_international"] = df["is_international"].astype(str).str.lower().isin(["true", "1"])
    for c in ["app", "action", "origin", "destination", "travel_type", "booking_type"]:
        df[c] = df[c].astype(object).where(df[c].notna(), "none").astype(str)
    df = df[df["action"].isin(ACTIONS)]
    return df.sort_values("timestamp", kind="mergesort").reset_index(drop=True)


def _to_india_naive(values: pd.Series) -> pd.Series:
    """Training data is naive India time: naive values are kept, zone-aware ones converted to IST."""
    def one(v):
        if v is None or (isinstance(v, float) and np.isnan(v)) or v == "":
            return pd.NaT
        ts = pd.Timestamp(v)
        return ts.tz_convert("Asia/Kolkata").tz_localize(None) if ts.tzinfo else ts

    return pd.Series([one(v) for v in values], index=values.index, dtype="datetime64[ns]")


def _mode(values, default="none"):
    if len(values) == 0:
        return default, 0.0
    c = Counter(values).most_common(1)[0]
    return c[0], c[1] / len(values)


def vocab_from_features(features: list[str]) -> dict[str, list[str]]:
    """Category vocabularies, in training order, recovered from the one-hot feature names."""
    out = {}
    for p in ["dest", "app", "tt", "bt"]:
        prefix = f"hist_share_{p}_"
        out[p] = [f[len(prefix):] for f in features if f.startswith(prefix)]
    return out


def build_feature_row(ev: pd.DataFrame, as_of: pd.Timestamp, vocab: dict[str, list[str]]) -> dict | None:
    """Features for one user at `as_of`. `ev` must come from normalize_events. None if no prior booking."""
    snap64 = np.datetime64(pd.Timestamp(as_of), "ns")
    t = ev["timestamp"].to_numpy(dtype="datetime64[ns]")
    n_prior = int(np.searchsorted(t, snap64, side="left"))
    act = ev["action"].to_numpy(dtype=object)
    b_idx = np.flatnonzero(act == "booking")
    pb = b_idx[b_idx < n_prior]
    if len(pb) == 0:
        return None

    app = ev["app"].to_numpy(dtype=object)
    dest = ev["destination"].to_numpy(dtype=object)
    ttype = ev["travel_type"].to_numpy(dtype=object)
    btype = ev["booking_type"].to_numpy(dtype=object)
    amt = ev["booking_amount"].to_numpy(dtype=float)
    dur = ev["trip_duration_days"].to_numpy(dtype=float)
    fprice = ev["flight_price"].to_numpy(dtype=float)
    tprice = ev["train_price"].to_numpy(dtype=float)
    hprice = ev["hotel_price"].to_numpy(dtype=float)
    intl = ev["is_international"].to_numpy(dtype=bool)
    dep = ev["departure_date"].to_numpy(dtype="datetime64[ns]")
    hours = ev["timestamp"].dt.hour.to_numpy()
    dows = ev["timestamp"].dt.dayofweek.to_numpy()
    snap = pd.Timestamp(snap64)

    pt = t[:n_prior]
    pbt = t[pb]
    pamt = amt[pb]
    gaps = np.diff(pbt) / DAY if len(pb) > 1 else np.array([])
    last_b = pb[-1]
    in_7, in_30 = pt >= snap64 - 7 * DAY, pt >= snap64 - 30 * DAY
    in_90, in_365 = pt >= snap64 - 90 * DAY, pt >= snap64 - 365 * DAY
    b90, b365 = pbt >= snap64 - 90 * DAY, pbt >= snap64 - 365 * DAY
    searches = act[:n_prior] == "search"
    last_search = np.flatnonzero(searches)
    fv30 = (act[:n_prior] == "flight_view") & in_30 & (fprice[:n_prior] > 0)
    months_active = max(1.0, (snap64 - pt[0]) / DAY / 30.44)

    cur = np.arange(last_b + 1, n_prior)
    cur_nc = cur[act[cur] != "cancel"]
    p_dest, p_dest_share = _mode(list(dest[pb]))
    p_app, p_app_share = _mode(list(app[:n_prior]))
    b_app, _ = _mode(list(app[pb]))
    p_tt, _ = _mode(list(ttype[pb]))
    p_bt, _ = _mode(list(btype[pb]))
    ph, _ = _mode(list(hours[:n_prior]), 20)
    pd_, _ = _mode(list(dows[:n_prior]), 5)
    lead = (dep[pb] - pbt) / DAY
    n_cancel = int((act[:n_prior] == "cancel").sum())
    dest_counts = Counter(dest[pb])
    today = np.datetime64(snap.normalize(), "D")
    future_hol = HOLIDAY_DAYS[HOLIDAY_DAYS >= today]

    row = dict(
        home_city=ev["origin"].iloc[0],
        snapshot_month=snap.month, snapshot_day_of_week=snap.dayofweek,
        snapshot_is_weekend=int(snap.dayofweek >= 5),
        days_to_next_holiday_period=int((future_hol[0] - today) / np.timedelta64(1, "D")) if len(future_hol) else 365,
        days_since_last_event=round(float((snap64 - pt[-1]) / DAY), 5),
        days_since_last_booking=round(float((snap64 - t[last_b]) / DAY), 3),
        days_since_last_search=round(float((snap64 - pt[last_search[-1]]) / DAY), 3) if len(last_search) else -1.0,
        events_last_7_days=int(in_7.sum()), events_last_30_days=int(in_30.sum()),
        events_last_90_days=int(in_90.sum()), searches_last_30_days=int((searches & in_30).sum()),
        price_checks_last_30_days=int(((act[:n_prior] == "price_check") & in_30).sum()),
        bookings_last_90_days=int(b90.sum()), bookings_last_365_days=int(b365.sum()),
        total_bookings=int(len(pb)), monthly_booking_frequency=round(len(pb) / months_active, 4),
        average_booking_amount=round(float(pamt.mean()), 2),
        median_booking_amount=round(float(np.median(pamt)), 2),
        max_booking_amount=float(pamt.max()),
        total_spend_90_days=float(pamt[b90].sum()), total_spend_365_days=float(pamt[b365].sum()),
        avg_flight_price_viewed_30_days=round(float(fprice[:n_prior][fv30].mean()), 2) if fv30.any() else 0.0,
        preferred_hour=int(ph), preferred_day=int(pd_),
        weekend_ratio=round(float((dows[:n_prior] >= 5).mean()), 4),
        avg_lead_time_days=round(float(lead.mean()), 2),
        preferred_app=p_app, preferred_app_share=round(p_app_share, 4),
        preferred_booking_app=b_app,
        preferred_destination=p_dest, preferred_destination_share=round(p_dest_share, 4),
        preferred_travel_type=p_tt, preferred_booking_type=p_bt,
        unique_destinations=int(len(dest_counts)),
        repeat_destination_ratio=round(1 - len(dest_counts) / len(pb), 4),
        international_ratio=round(float(intl[pb].mean()), 4),
        avg_trip_duration=round(float(dur[pb].mean()), 2),
        average_days_between_bookings=round(float(gaps.mean()), 2) if len(gaps) else -1.0,
        std_days_between_bookings=round(float(gaps.std()), 2) if len(gaps) > 1 else -1.0,
        cancel_ratio=round(n_cancel / len(pb), 4),
        searches_per_booking=round(float(searches.sum()) / len(pb), 3),
        last_destination=dest[last_b], last_app=app[last_b], last_travel_type=ttype[last_b],
        last_booking_type=btype[last_b], last_trip_duration=int(dur[last_b]),
        last_booking_amount=float(amt[last_b]),
        current_session_events=int(len(cur_nc)),
        current_app=app[cur_nc[-1]] if len(cur_nc) else "none",
        current_search_destination=dest[cur_nc[-1]] if len(cur_nc) else "none",
        current_session_searches=int((act[cur_nc] == "search").sum()),
        current_session_price_checks=int((act[cur_nc] == "price_check").sum()),
        current_session_hotel_views=int((act[cur_nc] == "hotel_view").sum()),
        current_session_flight_views=int((act[cur_nc] == "flight_view").sum()),
    )

    # ---- v2: booking history shares (all-time and recency-weighted) ----
    cols = {"dest": dest, "app": app, "tt": ttype, "bt": btype}
    w = np.exp(-((snap64 - pbt) / DAY) / TAU_DAYS)
    for p, values in cols.items():
        vals = values[pb]
        n_tot, d_tot = float(len(pb)), float(w.sum())
        for v in vocab[p]:
            hit = vals == v
            row[f"hist_share_{p}_{v}"] = hit.sum() / max(n_tot, 1)
            row[f"hist_recent_share_{p}_{v}"] = w[hit].sum() / max(d_tot, 1e-9)
        if p == "dest":
            row["hist_recent_bookings"] = d_tot

    # ---- v2: current planning session (non-booking activity after the last booking) ----
    s = cur_nc  # same event set: after last booking, before as_of, cancels excluded
    n = len(s)
    has = n > 0
    for p, values in cols.items():
        vals = values[s]
        shares = np.array([(vals == v).sum() / max(n, 1) for v in vocab[p]])
        for v, sh in zip(vocab[p], shares):
            row[f"sess_share_{p}_{v}"] = sh
        row[f"sess_top_{p}"] = vocab[p][int(shares.argmax())] if has else "none"
        row[f"sess_top_{p}_share"] = float(shares.max()) if len(shares) else 0.0
    price = fprice[s] + tprice[s] + hprice[s]
    dep_in = (dep[s] - snap64) / DAY
    row["sess_mean_duration"] = float(dur[s].mean()) if has else -1
    row["sess_mean_price"] = float(price.mean()) if has else -1
    row["sess_mean_departure_in_days"] = float(dep_in.mean()) if has else -999
    row["sess_last_departure_in_days"] = float(dep_in[-1]) if has else -999
    row["sess_days_since_last_activity"] = float((snap64 - t[s[-1]]) / DAY) if has else -1

    # ---- v2: timing relative to the user's own rhythm ----
    gap, since = row["average_days_between_bookings"], row["days_since_last_booking"]
    row["gap_ratio"] = since / max(gap, 1e-3) if gap > 0 else -1
    row["gap_remaining_days"] = gap - since if gap > 0 else -999
    row["lead_adjusted_departure_gap"] = (row["sess_last_departure_in_days"] - row["avg_lead_time_days"]
                                          if has else -999)
    return row
