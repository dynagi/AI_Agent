"""
AURA travel next-booking models, v2: richer history/session features + Optuna-tuned LightGBM.

Compares on the same chronological test split:
    user's usual  ->  v1 (notebook features, notebook LightGBM settings)
                  ->  v2 features (same settings)  ->  v2 tuned  ->  v2 tuned, refit on train+validation

Every new feature uses only events strictly before snapshot_timestamp.

Usage:
    python train_improved.py                                        # travel/ -> models/
    python train_improved.py --data experiments/seed7/travel --models experiments/seed7/models \
                             --params-from models/travel_lightgbm_v2_params.json   # reuse tuned params
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import optuna
import pandas as pd
from sklearn.metrics import (accuracy_score, f1_score, mean_absolute_error, mean_squared_error, r2_score,
                             top_k_accuracy_score)

SEED = 42
HERE = Path(__file__).resolve().parent
TARGETS_CLS = ["next_destination", "next_app", "next_travel_type", "next_booking_type"]
TARGETS_REG = ["days_until_next_trip", "expected_booking_amount", "expected_trip_duration"]
NON_FEATURES = ["snapshot_id", "user_id", "snapshot_timestamp", "target_timestamp", "split",
                "target_crosses_split", "synthetic", "days_until_next_departure"]
USUAL = {"next_destination": "preferred_destination", "next_app": "preferred_booking_app",
         "next_travel_type": "preferred_travel_type", "next_booking_type": "preferred_booking_type"}
ONEHOT = {"destination": "dest", "app": "app", "travel_type": "tt", "booking_type": "bt"}
TAU_DAYS = 90.0  # recency half-life-ish for decayed booking counts
DAY = pd.Timedelta(days=1)

# per-target Optuna time budget (seconds); destination has 37 classes and is the slowest
TUNE_SECONDS = {"next_destination": 420, "next_app": 150, "next_travel_type": 150, "next_booking_type": 150,
                "days_until_next_trip": 120, "expected_booking_amount": 120, "expected_trip_duration": 120}

V1_CLS = dict(objective="multiclass", learning_rate=0.08, num_leaves=31, min_child_samples=30,
              bagging_fraction=0.8, bagging_freq=1, feature_fraction=0.7, lambda_l2=1.0)
V1_REG = dict(objective="regression", learning_rate=0.05, num_leaves=31, min_child_samples=30,
              bagging_fraction=0.8, bagging_freq=1, feature_fraction=0.7)


# ----------------------------------------------------------------------------
# Features
# ----------------------------------------------------------------------------
def load(data_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    feats = pd.read_csv(data_dir / "travel_features.csv", parse_dates=["snapshot_timestamp", "target_timestamp"])
    feats = feats[~feats["target_crosses_split"]].reset_index(drop=True)  # strict purged evaluation
    ev = pd.read_csv(data_dir / "travel_events.csv",
                     usecols=["user_id", "timestamp", "action", "destination", "app", "travel_type", "booking_type",
                              "trip_duration_days", "departure_date", "flight_price", "train_price", "hotel_price"],
                     parse_dates=["timestamp", "departure_date"])
    return feats, ev


def _asof(left: pd.DataFrame, right: pd.DataFrame, on: str, exact: bool) -> pd.DataFrame:
    """Last row of `right` per user at or before (exact=True) / strictly before left[on]."""
    out = pd.merge_asof(left.sort_values(on), right, left_on=on, right_on="ts", by="user_id",
                        direction="backward", allow_exact_matches=exact)
    return out.set_index("row").sort_index()


def add_v2_features(feats: pd.DataFrame, ev: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    ev = ev.sort_values("timestamp", kind="mergesort").reset_index(drop=True)
    ev["ts"] = ev["timestamp"].astype("datetime64[ns]")
    t0 = ev["ts"].min()
    ev_days = ((ev["ts"] - t0) / DAY).to_numpy()
    vocab = {c: sorted(ev[c].astype(str).unique()) for c in ONEHOT}

    def onehot(df):
        return pd.DataFrame({f"{p}_{v}": (df[c].astype(str).to_numpy() == v).astype(np.float64)
                             for c, p in ONEHOT.items() for v in vocab[c]}, index=df.index)

    snaps = pd.DataFrame({"row": np.arange(len(feats)), "user_id": feats["user_id"].to_numpy(),
                          "snap_ts": feats["snapshot_timestamp"].astype("datetime64[ns]").to_numpy()})
    snap_days = ((snaps["snap_ts"] - t0) / DAY).to_numpy()
    new = {}

    # ---- booking history: all-time share and recency-weighted share per category ----
    bk = ev[ev["action"] == "booking"]
    oh = onehot(bk)
    w = np.exp(ev_days[bk.index] / TAU_DAYS)
    cnt = oh.groupby(bk["user_id"].to_numpy()).cumsum()
    dec = oh.mul(w, axis=0).groupby(bk["user_id"].to_numpy()).cumsum()
    B = pd.concat([bk[["user_id", "ts"]], cnt.add_prefix("hcnt_"), dec.add_prefix("hdec_")], axis=1)
    B["last_bk_ts"] = bk["ts"]
    hb = _asof(snaps, B, "snap_ts", exact=False)
    decay = np.exp(-snap_days / TAU_DAYS)
    for c, p in ONEHOT.items():
        cols = [f"{p}_{v}" for v in vocab[c]]
        n = hb[[f"hcnt_{k}" for k in cols]].to_numpy()
        d = hb[[f"hdec_{k}" for k in cols]].to_numpy() * decay[:, None]
        n_tot, d_tot = n.sum(1, keepdims=True), d.sum(1, keepdims=True)
        for j, k in enumerate(cols):
            new[f"hist_share_{k}"] = n[:, j] / np.maximum(n_tot[:, 0], 1)
            new[f"hist_recent_share_{k}"] = d[:, j] / np.maximum(d_tot[:, 0], 1e-9)
        if c == "destination":
            new["hist_recent_bookings"] = d_tot[:, 0]

    # ---- current planning session: non-booking activity after the last booking ----
    se = ev[~ev["action"].isin(["booking", "cancel"])]
    so = onehot(se)
    so["n"] = 1.0
    so["dur"] = se["trip_duration_days"].astype(float)
    so["price"] = se[["flight_price", "train_price", "hotel_price"]].sum(axis=1).astype(float)
    so["dep_day"] = ((se["departure_date"].astype("datetime64[ns]") - t0) / DAY).to_numpy()
    S = pd.concat([se[["user_id", "ts"]], so.groupby(se["user_id"].to_numpy()).cumsum()], axis=1)
    S["last_dep_day"] = so["dep_day"]
    S["last_ts_day"] = ev_days[se.index]
    at_snap = _asof(snaps, S, "snap_ts", exact=False)
    lb = snaps.assign(lb_ts=hb["last_bk_ts"].fillna(t0 - DAY).astype("datetime64[ns]").to_numpy())
    at_lb = _asof(lb, S, "lb_ts", exact=True)
    cum_cols = [c for c in so.columns]
    sess = at_snap[cum_cols].fillna(0).to_numpy() - at_lb[cum_cols].fillna(0).to_numpy()
    sess = pd.DataFrame(sess, columns=cum_cols)
    n = sess["n"].to_numpy()
    has = n > 0
    safe_n = np.maximum(n, 1)
    for c, p in ONEHOT.items():
        cols = [f"{p}_{v}" for v in vocab[c]]
        shares = sess[cols].to_numpy() / safe_n[:, None]
        for j, k in enumerate(cols):
            new[f"sess_share_{k}"] = shares[:, j]
        top = shares.argmax(1)
        new[f"sess_top_{p}"] = np.where(has, np.array(vocab[c], dtype=object)[top], "none")
        new[f"sess_top_{p}_share"] = shares.max(1)
    new["sess_mean_duration"] = np.where(has, sess["dur"] / safe_n, -1)
    new["sess_mean_price"] = np.where(has, sess["price"] / safe_n, -1)
    new["sess_mean_departure_in_days"] = np.where(has, sess["dep_day"] / safe_n - snap_days, -999)
    new["sess_last_departure_in_days"] = np.where(has, at_snap["last_dep_day"].to_numpy() - snap_days, -999)
    new["sess_days_since_last_activity"] = np.where(has, snap_days - at_snap["last_ts_day"].to_numpy(), -1)

    # ---- timing relative to the user's own rhythm ----
    gap = feats["average_days_between_bookings"].to_numpy()
    since = feats["days_since_last_booking"].to_numpy()
    new["gap_ratio"] = np.where(gap > 0, since / np.maximum(gap, 1e-3), -1)
    new["gap_remaining_days"] = np.where(gap > 0, gap - since, -999)
    new["lead_adjusted_departure_gap"] = np.where(has, new["sess_last_departure_in_days"]
                                                  - feats["avg_lead_time_days"].to_numpy(), -999)

    new = pd.DataFrame(new, index=feats.index)
    return pd.concat([feats, new], axis=1), list(new.columns)


# ----------------------------------------------------------------------------
# Modelling helpers
# ----------------------------------------------------------------------------
def to_lgb_frame(df: pd.DataFrame, features: list[str]) -> tuple[pd.DataFrame, dict]:
    X = df[features].copy()
    cats = {}
    for c in features:
        if pd.api.types.is_bool_dtype(X[c]):
            X[c] = X[c].astype(int)
        elif not pd.api.types.is_numeric_dtype(X[c]):
            cats[c] = sorted(X[c].astype(str).unique())
            X[c] = pd.Categorical(X[c].astype(str), categories=cats[c])
    return X, cats


def fit(params, X, y, mask_fit, mask_val=None, rounds=None, n_class=None):
    p = dict(params, seed=SEED, verbose=-1, num_threads=0)
    if n_class:
        p["num_class"] = n_class
    dtr = lgb.Dataset(X[mask_fit], y[mask_fit], free_raw_data=False)
    if mask_val is None:
        return lgb.train(p, dtr, num_boost_round=rounds)
    dva = lgb.Dataset(X[mask_val], y[mask_val], reference=dtr)
    return lgb.train(p, dtr, num_boost_round=5000, valid_sets=[dva],
                     callbacks=[lgb.early_stopping(50 if n_class else 100, verbose=False)])


def tune(target, X, y, tr, va, n_class, seconds):
    def objective(trial):
        p = dict(learning_rate=0.04,
                 num_leaves=trial.suggest_int("num_leaves", 7, 127, log=True),
                 min_child_samples=trial.suggest_int("min_child_samples", 10, 400, log=True),
                 feature_fraction=trial.suggest_float("feature_fraction", 0.2, 1.0),
                 bagging_fraction=trial.suggest_float("bagging_fraction", 0.5, 1.0), bagging_freq=1,
                 lambda_l2=trial.suggest_float("lambda_l2", 1e-3, 50, log=True),
                 min_gain_to_split=trial.suggest_float("min_gain_to_split", 0, 1.0),
                 max_bin=trial.suggest_categorical("max_bin", [63, 255]))
        if n_class:
            p["objective"] = "multiclass"
            m = fit(p, X, y, tr, va, n_class=n_class)
            score = m.best_score["valid_0"]["multi_logloss"]
        else:
            p["objective"] = trial.suggest_categorical("objective", ["regression", "huber", "regression_l1"])
            m = fit(p, X, y, tr, va)
            score = mean_absolute_error(np.expm1(y[va]), np.expm1(m.predict(X[va], num_iteration=m.best_iteration)))
        trial.set_user_attr("best_iteration", m.best_iteration)
        return score

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=SEED))
    study.optimize(objective, timeout=seconds, n_trials=60)
    best = dict(study.best_params, learning_rate=0.04, bagging_freq=1)
    if n_class:
        best["objective"] = "multiclass"
    print(f"    tuned {target}: {len(study.trials)} trials, best val={study.best_value:.4f}")
    return best, study.best_trial.user_attrs["best_iteration"]


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=HERE / "travel")
    ap.add_argument("--models", type=Path, default=HERE / "models")
    ap.add_argument("--params-from", type=Path, default=None, help="reuse tuned params instead of running Optuna")
    args = ap.parse_args()
    args.models.mkdir(parents=True, exist_ok=True)
    t_start = time.time()

    feats, ev = load(args.data)
    feats, v2_new = add_v2_features(feats, ev)
    del ev
    v1_features = [c for c in feats.columns if c not in NON_FEATURES + TARGETS_CLS + TARGETS_REG + v2_new]
    v2_features = v1_features + v2_new
    tr = (feats["split"] == "train").to_numpy()
    va = (feats["split"] == "validation").to_numpy()
    te = (feats["split"] == "test").to_numpy()
    trva = tr | va
    print(f"rows train={tr.sum():,} val={va.sum():,} test={te.sum():,} | "
          f"features v1={len(v1_features)} v2={len(v2_features)} ({time.time() - t_start:.0f}s)")

    X1, _ = to_lgb_frame(feats, v1_features)
    X2, cats2 = to_lgb_frame(feats, v2_features)
    labels = {t: sorted(feats[t].unique()) for t in TARGETS_CLS}
    Y = {t: pd.Categorical(feats[t], categories=labels[t]).codes.astype(np.int64) for t in TARGETS_CLS}
    Y.update({t: np.log1p(feats[t].to_numpy(dtype=float)) for t in TARGETS_REG})

    results = []

    def score_cls(t, name, proba):
        y = Y[t][te]
        k = proba.shape[1]
        pred = proba.argmax(1)
        r = dict(target=t, model=name, accuracy=accuracy_score(y, pred),
                 top3_accuracy=top_k_accuracy_score(y, proba, k=min(3, k - 1), labels=np.arange(k)),
                 macro_f1=f1_score(y, pred, average="macro"))
        results.append(r)
        print(f"  {name:<26} acc={r['accuracy']:.3f}  top3={r['top3_accuracy']:.3f}  macroF1={r['macro_f1']:.3f}")

    def score_reg(t, name, pred):
        y = np.expm1(Y[t][te])
        pred = np.clip(pred, 0, None)
        r = dict(target=t, model=name, MAE=mean_absolute_error(y, pred),
                 RMSE=float(np.sqrt(mean_squared_error(y, pred))), R2=r2_score(y, pred))
        results.append(r)
        print(f"  {name:<26} MAE={r['MAE']:,.2f}  RMSE={r['RMSE']:,.2f}  R2={r['R2']:.3f}")

    tuned_params = json.loads(args.params_from.read_text()) if args.params_from else {}
    final_models, final_meta = {}, {}

    for t in TARGETS_CLS + TARGETS_REG:
        t0 = time.time()
        is_cls = t in TARGETS_CLS
        K = len(labels[t]) if is_cls else None
        y = Y[t]
        print(t)

        if is_cls:
            usual = pd.Categorical(feats.loc[te, USUAL[t]], categories=labels[t]).codes
            p = np.full((te.sum(), K), 1e-6)
            p[np.arange(te.sum()), np.where(usual < 0, 0, usual)] = 1.0
            score_cls(t, "Baseline: user's usual", p)
            predict = lambda m, X: m.predict(X[te], num_iteration=m.best_iteration or None)
            report = score_cls
        else:
            score_reg(t, "Baseline: train median", np.full(te.sum(), np.median(np.expm1(y[tr]))))
            predict = lambda m, X: np.expm1(m.predict(X[te], num_iteration=m.best_iteration or None))
            report = score_reg

        base = V1_CLS if is_cls else V1_REG
        report(t, "v1 LightGBM", predict(fit(base, X1, y, tr, va, n_class=K), X1))
        report(t, "v2 features", predict(fit(base, X2, y, tr, va, n_class=K), X2))

        if t in tuned_params:
            best = tuned_params[t]["params"]
            m = fit(best, X2, y, tr, va, n_class=K)
            best_iter = m.best_iteration
        else:
            best, best_iter = tune(t, X2, y, tr, va, K, TUNE_SECONDS[t])
            m = fit(best, X2, y, tr, va, n_class=K)
            best_iter = m.best_iteration
            tuned_params[t] = dict(params=best, best_iteration=best_iter)
        report(t, "v2 tuned", predict(m, X2))

        # final model: same settings, refit on train+validation (all earlier than test) with ~15% more rounds
        rounds = max(20, int(best_iter * 1.15))
        final = fit(best, X2, y, trva, rounds=rounds, n_class=K)
        report(t, "v2 tuned + train&val", predict(final, X2))
        final_models[t] = final
        final_meta[t] = dict(rounds=rounds, log1p_target=not is_cls)
        print(f"  ({time.time() - t0:.0f}s)")

    res = pd.DataFrame(results)
    res.to_csv(args.models / "travel_results_v2.csv", index=False)
    joblib.dump(final_models, args.models / "travel_lightgbm_v2.joblib")
    (args.models / "travel_lightgbm_v2_params.json").write_text(json.dumps(tuned_params, indent=1))
    (args.models / "travel_features_v2.json").write_text(json.dumps(dict(
        features=v2_features, categorical_levels=cats2, labels=labels, targets=final_meta,
        tau_days=TAU_DAYS, trained_on=str(args.data), note="regression models predict log1p(y); use expm1"),
        indent=1))

    print("\n=== SUMMARY (test set) ===")
    cls = res[res.target.isin(TARGETS_CLS)]
    for metric in ["accuracy", "top3_accuracy"]:
        print(f"\n{metric}")
        print(cls.pivot(index="model", columns="target", values=metric)[TARGETS_CLS].round(3).to_string())
    print("\nMAE (days / INR / days)")
    print(res[res.target.isin(TARGETS_REG)].pivot(index="model", columns="target", values="MAE")[TARGETS_REG]
          .round(2).to_string())
    print(f"\nsaved to {args.models} | total {time.time() - t_start:.0f}s")


if __name__ == "__main__":
    main()
