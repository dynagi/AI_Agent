"""Builds labelled training rows from shopping events and fits the LightGBM next-purchase model.

Shared by the offline script (synthetic_data/train_shopping.py, trains the base model on synthetic
users) and the in-service retrainer (app/ml/shopping_predictor.py, fine-tunes the base model on real
AURA users' events every time someone gives the shopping agent a command).
"""
from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd

from app.ml.shopping_features import (HORIZON_DAYS, _UserIndex, feature_rows, to_model_input)

PARAMS = {
    "objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 100,
    "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "lambda_l2": 1.0,
    "verbose": -1, "seed": 42, "num_threads": 0,
}
DAY = pd.Timedelta(days=1)


def snapshot_times(ev: pd.DataFrame, rng: np.random.Generator, n: int, end: pd.Timestamp,
                   warmup_days: float = 30) -> list[pd.Timestamp]:
    """n random snapshot times between warm-up after the user's first event and `end`."""
    if ev.empty:
        return []
    lo = ev["timestamp"].iloc[0] + warmup_days * DAY
    if lo >= end:
        return []
    span = (end - lo) / DAY
    return sorted(lo + float(x) * DAY for x in rng.uniform(0, span, n))


def user_rows(ev: pd.DataFrame, as_ofs: list[pd.Timestamp], stats: dict, now: pd.Timestamp | None = None) -> list[dict]:
    """Labelled rows for one user (normalized events, all of them, so labels can see the future).
    With `now`, snapshots whose 7-day window is still open keep positives at full weight but
    down-weight negatives by how much of the window has been observed (it may still happen)."""
    ux = _UserIndex(ev)  # feature_rows only reads events before each as_of, so one index serves all snapshots
    rows = []
    for as_of in as_ofs:
        observed = 1.0 if now is None else min(1.0, max(0.0, (now - as_of) / DAY / HORIZON_DAYS))
        for r in feature_rows(ux, as_of, stats, with_label=True):
            r.update(as_of=as_of, weight=1.0 if r["label"] else max(observed, 0.05))
            rows.append(r)
    return rows


def fit(train: pd.DataFrame, categories: list[str], rounds: int, params: dict | None = None,
        valid: pd.DataFrame | None = None, init_model: lgb.Booster | None = None,
        weight_col: str = "weight") -> lgb.Booster:
    params = {**PARAMS, **(params or {})}
    dtrain = lgb.Dataset(to_model_input(train, categories), train["label"],
                         weight=train[weight_col] if weight_col in train else None, categorical_feature=["category"],
                         free_raw_data=False)
    sets, callbacks = [dtrain], []
    if valid is not None:
        sets.append(lgb.Dataset(to_model_input(valid, categories), valid["label"], reference=dtrain))
        callbacks = [lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)]
        params["metric"] = ["auc", "binary_logloss"]
    return lgb.train(params, dtrain, num_boost_round=rounds, valid_sets=sets, callbacks=callbacks,
                     init_model=init_model)
