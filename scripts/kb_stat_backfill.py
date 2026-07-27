#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backfill knowledge base statistics snapshots for a given date range."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta

# Load .env from knowledge_runtime directory so settings are available
_env_path = os.path.join(os.path.dirname(__file__), "..", "knowledge_runtime", ".env")
if os.path.exists(_env_path):
    from dotenv import load_dotenv

    load_dotenv(_env_path)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="KB statistics backfill")
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--date", type=date.fromisoformat, help="Single day backfill")
    grp.add_argument(
        "--start-date", type=date.fromisoformat, help="Range start (with --end-date)"
    )
    p.add_argument("--end-date", type=date.fromisoformat, help="Range end (inclusive)")
    p.add_argument(
        "--kb-id",
        type=int,
        action="append",
        default=[],
        help="KB id filter (repeatable)",
    )
    p.add_argument("--namespace", type=str, default=None)
    p.add_argument(
        "--domain",
        type=str,
        action="append",
        default=[],
        help="Domain filter (repeatable)",
    )
    p.add_argument(
        "--dry-run", action="store_true", help="Print actions without executing"
    )
    p.add_argument(
        "--via", choices=("celery", "direct"), default="celery", help="Execution mode"
    )
    return p.parse_args()


def date_range(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def trigger_via_celery(target: date, kb_ids, domains):
    from knowledge_runtime.tasks.celery_app import celery_app

    return celery_app.send_task(
        "kb_stat.collect_all",
        kwargs=dict(
            target_date_iso=target.isoformat(),
            kb_ids=kb_ids or None,
            domains=domains or None,
            triggered_by="manual_cli",
        ),
        queue="kb_stat",
    ).id


def trigger_direct(target: date, kb_ids, domains):
    from knowledge_engine.stat import collect_all
    from shared.db.readonly_session import get_readonly_session_factory
    from shared.db.stat_session import get_stat_session_factory

    # sessionmaker is callable; calling it returns a Session
    return collect_all(
        target_date=target,
        kb_ids=kb_ids or None,
        domains=domains or None,
        triggered_by="manual_cli",
        source_session_factory=get_readonly_session_factory(),
        stat_session_factory=get_stat_session_factory(),
    )


def main() -> int:
    args = parse_args()
    targets = (
        [args.date] if args.date else list(date_range(args.start_date, args.end_date))
    )

    if args.start_date and not args.end_date:
        print("ERROR: --start-date requires --end-date")
        return 1
    if args.end_date and not args.start_date:
        print("ERROR: --end-date requires --start-date")
        return 1
    if args.start_date and args.end_date and args.start_date > args.end_date:
        print("ERROR: --start-date cannot be after --end-date")
        return 1

    print(f"Will trigger {len(targets)} run(s) via {args.via}")
    if args.dry_run:
        for d in targets:
            print(f"  - {d}  kb_ids={args.kb_id}  domains={args.domain}")
        return 0

    for d in targets:
        if args.via == "celery":
            tid = trigger_via_celery(d, args.kb_id, args.domain)
            print(f"  + {d} -> celery task {tid}")
        else:
            run_id = trigger_direct(d, args.kb_id, args.domain)
            print(f"  + {d} -> run_id {run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
