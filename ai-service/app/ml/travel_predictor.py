"""Next-trip predictions from the LightGBM travel model (synthetic_data/train_improved.py, v2)."""
from __future__ import annotations

import json
import threading
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from app.ml.travel_features import build_feature_row, normalize_events, vocab_from_features

MODEL_VERSION = "travel_lightgbm_v2"

# model target -> response field
_CLS_FIELDS = {"next_destination": "destination", "next_app": "app", "next_travel_type": "travelType",
               "next_booking_type": "bookingType"}


class TravelPredictor:
    def __init__(self, model_dir: Path):
        self.models = joblib.load(model_dir / "travel_lightgbm_v2.joblib")
        self.spec = json.loads((model_dir / "travel_features_v2.json").read_text())
        self.features: list[str] = self.spec["features"]
        self.cat_levels: dict[str, list[str]] = self.spec["categorical_levels"]
        self.labels: dict[str, list[str]] = self.spec["labels"]
        self.vocab = vocab_from_features(self.features)

    def feature_frame(self, row: dict) -> pd.DataFrame:
        X = pd.DataFrame([{f: row[f] for f in self.features}])
        for c, levels in self.cat_levels.items():
            X[c] = pd.Categorical(X[c].astype(str), categories=levels)
        return X

    def predict(self, events: pd.DataFrame | list[dict], as_of: pd.Timestamp) -> dict:
        ev = normalize_events(events)
        row = build_feature_row(ev, as_of, self.vocab)
        if row is None:
            return _cold_start(ev, as_of)

        X = self.feature_frame(row)
        predictions: dict = {}
        for target, field in _CLS_FIELDS.items():
            proba = self.models[target].predict(X)[0]
            top = np.argsort(proba)[::-1][:3]
            predictions[field] = [{"value": self.labels[target][i], "probability": round(float(proba[i]), 3)}
                                  for i in top]
        reg = {t: float(np.expm1(self.models[t].predict(X)[0])) for t in
               ["days_until_next_trip", "expected_booking_amount", "expected_trip_duration"]}
        predictions["daysUntilNextBooking"] = round(max(reg["days_until_next_trip"], 0.0), 1)
        predictions["expectedBookingAmountInr"] = round(max(reg["expected_booking_amount"], 0.0), -2)
        predictions["expectedTripDurationDays"] = max(1, int(round(reg["expected_trip_duration"])))

        prior = ev[ev["timestamp"] < as_of]
        bookings = prior[prior["action"] == "booking"]
        planning = None
        if row["current_session_events"] > 0:
            dep = row["sess_last_departure_in_days"]
            planning = {"destination": row["sess_top_dest"], "app": row["current_app"],
                        "searches": row["current_session_searches"],
                        "priceChecks": row["current_session_price_checks"],
                        "departureInDays": round(dep, 1) if dep > -999 else None,
                        "travelDate": str((as_of.normalize() + pd.Timedelta(days=round(dep))).date())
                        if dep > -999 else None}
        return {
            "status": "ok",
            "asOf": as_of.isoformat(),
            "modelVersion": MODEL_VERSION,
            "predictions": predictions,
            "activePlanning": planning,
            "history": _history_summary(bookings, row),
            "caveats": [
                "Model trained on synthetic data; retrain on real AURA events before trusting exact numbers.",
                "Destination/app/type are most useful as top-3 suggestions; the timing estimate is rough.",
            ],
        }


def _history_summary(bookings: pd.DataFrame, row: dict) -> dict:
    last = bookings.iloc[-1]
    favs = bookings["destination"].value_counts().head(3)
    return {
        "homeCity": row["home_city"],
        "totalBookings": int(len(bookings)),
        "favouriteDestinations": [{"destination": d, "trips": int(n)} for d, n in favs.items()],
        "preferredApp": row["preferred_booking_app"],
        "usualTravelType": row["preferred_travel_type"],
        "averageDaysBetweenTrips": row["average_days_between_bookings"] if row["average_days_between_bookings"] > 0 else None,
        "averageBookingAmountInr": row["average_booking_amount"],
        "lastTrip": {"destination": last["destination"], "bookedOn": str(last["timestamp"].date()),
                     "departure": str(last["departure_date"].date()) if pd.notna(last["departure_date"]) else None,
                     "travelType": last["travel_type"], "app": last["app"],
                     "amountInr": float(last["booking_amount"])},
    }


def _cold_start(ev: pd.DataFrame, as_of: pd.Timestamp) -> dict:
    prior = ev[ev["timestamp"] < as_of]
    searched = prior[prior["action"] != "cancel"]["destination"].value_counts().head(3)
    return {
        "status": "cold_start",
        "asOf": as_of.isoformat(),
        "modelVersion": MODEL_VERSION,
        "predictions": None,
        "activePlanning": {"destination": searched.index[0], "searches": int(searched.iloc[0])} if len(searched) else None,
        "history": {"totalBookings": 0, "recentlySearched": list(searched.index)},
        "caveats": ["No past bookings yet, so personalised predictions start after the first booked trip."],
    }


_predictor: TravelPredictor | None = None
_lock = threading.Lock()


def get_predictor() -> TravelPredictor:
    """Loads the model once (about 1s) on first use."""
    global _predictor
    if _predictor is None:
        with _lock:
            if _predictor is None:
                from app.core.config import settings
                _predictor = TravelPredictor(Path(settings.travel_model_dir))
    return _predictor
