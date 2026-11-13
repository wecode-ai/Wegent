#!/usr/bin/env python3
"""Backfill missing plugin state using the same initializer as foreground writes.

Preview: uv run python scripts/backfill_plugin_states.py --user-id 151
Apply:   uv run python scripts/backfill_plugin_states.py --apply --user-id 151
Resume:  uv run python scripts/backfill_plugin_states.py --apply --after-id ID

Legacy PluginSyncState rows must be read-only after the coordinated cutover.
Existing states are never overwritten; legacy rows are never deleted.
"""

import argparse
import json
import sys
import time
from pathlib import Path

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.device.plugin_sync_protocol import lock_plugin_sync_state
from app.services.plugin_state_history import LEGACY_SYNC_KEY
from app.services.plugin_state_store import find_plugin_state, prepare_plugin_identity
from app.services.plugin_write_coordination import configure_plugin_session


def candidates(db: Session, after_id: int, batch_size: int, user_id: int | None):
    query = db.query(Kind.id, Kind.user_id, Kind.kind).filter(
        Kind.id > after_id,
        or_(
            and_(Kind.kind == "InstalledPlugin", Kind.namespace == "default"),
            and_(
                Kind.kind == "PluginSyncState",
                Kind.namespace == "plugin-sync",
                Kind.name == "account",
                Kind.is_active.is_(True),
            ),
        ),
    )
    if user_id is not None:
        query = query.filter(Kind.user_id == user_id)
    return query.order_by(Kind.id).limit(batch_size).all()


def backfill_one(
    db: Session, source_id: int, user_id: int, kind: str, apply: bool
) -> str:
    """Process one current identity in a short transaction; never merge into it."""
    configure_plugin_session(db)
    row = (
        db.query(Kind)
        .filter_by(
            id=source_id,
            user_id=user_id,
            kind=kind,
            namespace="default" if kind == "InstalledPlugin" else "plugin-sync",
        )
        .one_or_none()
    )
    if row is None:
        return "skipped"
    if kind == "PluginSyncState" and (row.name != "account" or not row.is_active):
        return "skipped"
    key = row.name if kind == "InstalledPlugin" else LEGACY_SYNC_KEY
    installed_id = row.id if kind == "InstalledPlugin" else 0
    existing = find_plugin_state(db, user_id, key)
    if existing is None and installed_id:
        existing = (
            db.query(PluginState)
            .filter_by(user_id=user_id, installed_kind_id=installed_id)
            .one_or_none()
        )
    if existing is not None:
        return "skipped"
    if not apply:
        prepare_plugin_identity(db, user_id, key, installed_id)
        return "pending"
    lock_plugin_sync_state(db, user_id, plugin_key=key, installed_kind_id=installed_id)
    db.commit()
    return "initialized_or_concurrent"


def backfill(
    session_factory=SessionLocal,
    *,
    user_id: int | None = None,
    batch_size: int = 100,
    after_id: int = 0,
    apply: bool = False,
    pause_ms: int = 100,
    report=print,
) -> dict:
    """A failed row leaves the resume cursor before that row, even after COMMIT."""
    result = {
        "resume_after_id": after_id,
        "processed": 0,
        "skipped": 0,
        "pending": 0,
        "initialized_or_concurrent": 0,
        "mode": "apply" if apply else "dry-run",
    }
    while True:
        with session_factory() as db:
            configure_plugin_session(db)
            rows = candidates(db, result["resume_after_id"], batch_size, user_id)
        if not rows:
            result["complete"] = True
            report(json.dumps(result))
            return result
        for row in rows:
            try:
                with session_factory() as db:
                    outcome = backfill_one(db, row.id, row.user_id, row.kind, apply)
                result[outcome] += 1
                result["processed"] += 1
                result["resume_after_id"] = row.id
            except Exception as error:
                report(
                    json.dumps(
                        {
                            **result,
                            "failed_id": row.id,
                            "error_type": type(error).__name__,
                        }
                    )
                )
                raise
        report(json.dumps(result))
        if pause_ms:
            time.sleep(pause_ms / 1000)


def positive(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def nonnegative(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return number


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--user-id", type=positive)
    parser.add_argument("--batch-size", type=positive, default=100)
    parser.add_argument("--after-id", type=nonnegative, default=0)
    parser.add_argument("--pause-ms", type=nonnegative, default=100)
    args = parser.parse_args()
    try:
        backfill(
            user_id=args.user_id,
            batch_size=args.batch_size,
            after_id=args.after_id,
            apply=args.apply,
            pause_ms=args.pause_ms,
        )
    except Exception as error:
        # Include failures before the first batch without exposing SQL or URLs.
        print(
            json.dumps({"status": "failed", "error_type": type(error).__name__}),
            file=sys.stderr,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
