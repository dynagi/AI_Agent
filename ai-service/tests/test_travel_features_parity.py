"""Serving features must equal training features, or the model silently gets wrong inputs.

Rebuilds features for random training snapshots with app.ml.travel_features and compares them
against the dataset the model was trained on (synthetic_data/experiments/seed7_long). Skipped
when that dataset isn't on disk.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.ml.travel_features import build_feature_row, normalize_events
from app.ml.travel_predictor import get_predictor

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "synthetic_data" / "experiments" / "seed7_long" / "travel"

pytestmark = pytest.mark.skipif(not (DATA / "travel_events.csv").exists(), reason="training dataset not on disk")


@pytest.fixture(scope="module")
def training_rows():
    sys.path.insert(0, str(REPO / "synthetic_data"))
    import train_improved

    feats, ev = train_improved.load(DATA)
    users = feats["user_id"].drop_duplicates().sample(60, random_state=0)
    feats = feats[feats["user_id"].isin(users)].reset_index(drop=True)
    full_ev = pd.read_csv(DATA / "travel_events.csv")
    full_ev = full_ev[full_ev["user_id"].isin(users)]
    feats, _ = train_improved.add_v2_features(feats, ev[ev["user_id"].isin(users)])
    return feats.sample(400, random_state=0), full_ev


def test_serving_features_match_training(training_rows):
    feats, ev = training_rows
    predictor = get_predictor()
    by_user = {u: normalize_events(g) for u, g in ev.groupby("user_id")}
    mismatches = []
    for _, r in feats.iterrows():
        row = build_feature_row(by_user[r["user_id"]], r["snapshot_timestamp"], predictor.vocab)
        assert row is not None
        for f in predictor.features:
            a, b = row[f], r[f]
            if isinstance(b, (bool, np.bool_)):
                b = int(b)
            if isinstance(b, str) or isinstance(a, str):
                ok = str(a) == str(b)
            else:
                ok = np.isclose(float(a), float(b), rtol=1e-6, atol=1e-6)
            if not ok:
                mismatches.append((r["snapshot_id"], f, a, b))
    assert not mismatches, f"{len(mismatches)} mismatches, e.g. {mismatches[:10]}"
