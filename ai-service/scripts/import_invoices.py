"""Import order invoices (PDF) into a user's shopping history, then retrain the shopping model on it.

Parsing is local and rule-based (app/services/invoice_parser.py): only store, restaurant, date, items, quantities
and prices are kept; names, addresses and tax details in the PDFs are never stored or sent anywhere.
Re-running is safe: order lines already imported are skipped.

Usage (from ai-service/):
    .venv/Scripts/python scripts/import_invoices.py --folder ../my_invoices --user <supabase user id> --dry-run
    .venv/Scripts/python scripts/import_invoices.py --folder ../my_invoices --user <supabase user id>
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.ml.shopping_predictor import get_predictor, now_ist  # noqa: E402
from app.services.invoice_parser import order_events, parse_invoice  # noqa: E402
from app.services.shopping_history import shopping_history  # noqa: E402


def read_pdf(path: Path) -> str:
    with pdfplumber.open(path) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", required=True)
    ap.add_argument("--user", required=True, help="Supabase user id the orders belong to")
    ap.add_argument("--dry-run", action="store_true", help="parse and report, store nothing")
    ap.add_argument("--no-retrain", action="store_true")
    args = ap.parse_args()

    files = sorted(Path(args.folder).glob("*.pdf"))
    existing = await shopping_history.get_events(args.user)
    orders, skipped, events = [], [], []
    for f in files:
        order = parse_invoice(read_pdf(f))
        if order is None:
            skipped.append(f.name)
            continue
        orders.append(order)
        new = order_events(order, existing + events)
        events += new
    per_store = Counter(o["store"] for o in orders)
    print(f"{len(files)} files: {len(orders)} orders parsed ({dict(per_store)}), {len(skipped)} not recognised")
    for name in skipped:
        print(f"  not recognised: {name}")
    print(f"{len(events)} new order lines ({sum(len(o['items']) for o in orders) - len(events)} already imported)")
    if orders:
        days = sorted(o["timestamp"][:10] for o in orders)
        print(f"orders from {days[0]} to {days[-1]}")
    if args.dry_run:
        print("dry run: nothing stored")
        return
    if events:
        where = await shopping_history.add_events(args.user, events)
        print(f"stored {len(events)} order lines in {where}")
    if not args.no_retrain:
        users = await shopping_history.real_users_events()
        result = get_predictor().finetune(users, now_ist(), f"imported {len(events)} invoice lines")
        print("retrain:", json.dumps(result, indent=1, default=str))


if __name__ == "__main__":
    asyncio.run(main())
