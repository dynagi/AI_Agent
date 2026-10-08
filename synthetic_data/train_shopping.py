"""
AURA shopping next-purchase model: P(user orders item X in the next 7 days) for each candidate item.

Rows come from ai-service/app/ml/shopping_features.py (the exact code the service runs live).
Split: chronological, and the test period uses users never seen in training.
Compares against two naive rankers a hand-written assistant might use:
  * "most frequent"  - items the user bought most in the last 90 days
  * "most overdue"   - items whose time since last order is largest relative to the user's usual gap

Usage:
    python generate_shopping.py                      # synthetic users -> shopping/
    python train_shopping.py                         # shopping/ -> ../ai-service/models/shopping/
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from joblib import Parallel, delayed
from sklearn.metrics import log_loss, roc_auc_score

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "ai-service"))
from app.ml.shopping_catalog import CATEGORIES  # noqa: E402
from app.ml.shopping_features import FEATURES, HORIZON_DAYS, compute_stats, normalize_events, to_model_input  # noqa: E402
from app.ml.shopping_trainer import PARAMS, fit, snapshot_times, user_rows  # noqa: E402

VALID_START = pd.Timestamp("2026-03-01")
TEST_START = pd.Timestamp("2026-06-01")
END = pd.Timestamp("2026-09-30") - pd.Timedelta(days=HORIZON_DAYS)
MODEL_VERSION = "shopping_lightgbm_v1"


def _rows_for(chunk: list[tuple[str, pd.DataFrame]], stats: dict, n_snap: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    out = []
    for uid, ev in chunk:
        rows = user_rows(ev.reset_index(drop=True), snapshot_times(ev, rng, n_snap, END), stats)
        for r in rows:
            r["user_id"] = uid
        out += rows
    return pd.DataFrame(out)


def ranking_metrics(df: pd.DataFrame, score: str, k: int = 5) -> dict:
    """Per snapshot: of the items actually ordered in the next 7 days, how many are in our top k."""
    prec, rec, hit = [], [], []
    for _, g in df.groupby(["user_id", "as_of"], sort=False):
        pos = g["label"].sum()
        if pos == 0:
            continue
        top = g.nlargest(k, score)["label"].sum()
        prec.append(top / k)
        rec.append(top / pos)
        hit.append(top > 0)
    return {f"precision@{k}": round(float(np.mean(prec)), 4), f"recall@{k}": round(float(np.mean(rec)), 4),
            f"hit@{k}": round(float(np.mean(hit)), 4), "snapshots": len(prec)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "shopping"))
    ap.add_argument("--models", default=str(HERE.parent / "ai-service" / "models" / "shopping"))
    ap.add_argument("--snapshots", type=int, default=12, help="snapshots per user")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    t0 = time.time()

    raw = pd.read_csv(Path(args.data) / "shopping_events.csv")
    ev = normalize_events(raw)
    print(f"{ev['user_id'].nunique()} users, {len(ev):,} events  ({time.time() - t0:.0f}s)")

    rng = np.random.default_rng(args.seed)
    users = ev["user_id"].unique()
    test_users = set(rng.choice(users, size=len(users) // 5, replace=False))
    stats = compute_stats(ev[(ev["timestamp"] < VALID_START) & ~ev["user_id"].isin(test_users)])

    groups = list(ev.groupby("user_id", sort=False))
    chunks = [groups[i::24] for i in range(24)]
    rows = pd.concat(Parallel(n_jobs=-1)(delayed(_rows_for)(c, stats, args.snapshots, args.seed + i)
                                         for i, c in enumerate(chunks)), ignore_index=True)
    rows["is_test_user"] = rows["user_id"].isin(test_users)
    print(f"{len(rows):,} rows, positive rate {rows['label'].mean():.3f}  ({time.time() - t0:.0f}s)")

    train = rows[(rows["as_of"] < VALID_START) & ~rows["is_test_user"]]
    valid = rows[(rows["as_of"] >= VALID_START) & (rows["as_of"] < TEST_START) & ~rows["is_test_user"]]
    test = rows[(rows["as_of"] >= TEST_START) & rows["is_test_user"]].copy()
    print(f"train {len(train):,} / valid {len(valid):,} / test {len(test):,} (unseen users, last 4 months)")

    model = fit(train, CATEGORIES, rounds=3000, valid=valid)
    best = model.best_iteration or model.current_iteration()
    print(f"best iteration {best}  ({time.time() - t0:.0f}s)")

    test["model"] = model.predict(to_model_input(test, CATEGORIES), num_iteration=best)
    test["most_frequent"] = test["n_orders_90d"]
    test["most_overdue"] = np.where(test["gap_ratio"] > 0, test["gap_ratio"], -1)
    metrics = {
        "test_auc": round(roc_auc_score(test["label"], test["model"]), 4),
        "test_logloss": round(log_loss(test["label"], test["model"]), 4),
        "test_positive_rate": round(float(test["label"].mean()), 4),
        "ranking": {name: ranking_metrics(test, name) for name in ["model", "most_frequent", "most_overdue"]},
        "auc_baselines": {name: round(roc_auc_score(test["label"], test[name]), 4)
                          for name in ["most_frequent", "most_overdue"]},
    }
    # The hard, useful part: items bought every 10+ days (atta, detergent, shampoo...), where "is it due
    # this week?" depends on timing, not just habit. Weekly-or-faster items are almost always positive.
    slow = test[test["mean_gap"] >= 10]
    metrics["slow_items"] = {
        "rows": len(slow), "positive_rate": round(float(slow["label"].mean()), 4),
        "auc": {name: round(roc_auc_score(slow["label"], slow[name]), 4)
                for name in ["model", "most_frequent", "most_overdue"]},
        "ranking": {name: ranking_metrics(slow, name, k=3) for name in ["model", "most_frequent", "most_overdue"]},
    }
    print(json.dumps(metrics, indent=2))

    # final model: refit on everything before the test period (all users), same number of rounds
    final_rows = rows[rows["as_of"] < TEST_START]
    final = fit(final_rows, CATEGORIES, rounds=int(best * 1.1))
    final_stats = compute_stats(ev)
    imp = sorted(zip(FEATURES, final.feature_importance("gain")), key=lambda x: -x[1])

    out = Path(args.models)
    out.mkdir(parents=True, exist_ok=True)
    final.save_model(str(out / f"{MODEL_VERSION}.txt"))
    spec = {
        "model_version": MODEL_VERSION, "horizon_days": HORIZON_DAYS, "features": FEATURES,
        "categories": CATEGORIES, "params": PARAMS, "rounds": int(best * 1.1), "stats": final_stats,
        "metrics": metrics, "trained_on": f"{ev['user_id'].nunique()} synthetic users ({args.data})",
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "top_features": [[f, round(float(g), 1)] for f, g in imp[:15]],
    }
    (out / f"{MODEL_VERSION}.json").write_text(json.dumps(spec, indent=1))
    # a sample of the synthetic rows, kept with the model so in-service fine-tuning can mix them in
    # with real users' rows and not forget the general patterns
    sample = final_rows.sample(n=min(len(final_rows), 60_000), random_state=args.seed)
    joblib.dump(sample[FEATURES + ["label"]].reset_index(drop=True), out / "base_rows_sample.joblib", compress=3)
    print(f"saved -> {out}  ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
