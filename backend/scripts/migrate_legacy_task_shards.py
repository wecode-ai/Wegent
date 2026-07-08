#!/usr/bin/env python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.db.session import SessionLocal
from wecode.task_sharding.legacy_migration import (
    compare_legacy_task_shards,
    migrate_legacy_task_shards,
)
from wecode.task_sharding.shard import SHARD_COUNT
from wecode.task_sharding.task_id import SLOT_COUNT


def _print_runtime_info(db, *, user_id: int | None) -> None:
    bind = db.get_bind()
    url = bind.url.render_as_string(hide_password=True)
    last_shard = SHARD_COUNT - 1
    print(f"database={url}")
    print(f"scope=user_id:{user_id}" if user_id is not None else "scope=all_users")
    print("legacy_tables=tasks,subtasks")
    print(f"task_shards=tasks_0000..tasks_{last_shard:04d} count={SHARD_COUNT}")
    print(
        f"subtask_shards=subtasks_0000..subtasks_{last_shard:04d} count={SHARD_COUNT}"
    )
    print(f"hash_rule=slot=user_id%{SLOT_COUNT}, " f"physical_shard=slot%{SHARD_COUNT}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Copy legacy tasks/subtasks into owner hash shard tables."
    )
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Write rows. Omit for dry-run counts.",
    )
    parser.add_argument(
        "--compare",
        action="store_true",
        help="Compare legacy rows with shard rows without writing.",
    )
    parser.add_argument(
        "--user-id",
        type=int,
        default=None,
        help="Only migrate or compare legacy rows owned by this user.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print missing and mismatched row details when comparing.",
    )
    parser.add_argument(
        "--ignore-task-fields",
        default="",
        help="Comma-separated task fields to ignore during compare.",
    )
    args = parser.parse_args()
    ignore_task_fields = tuple(
        field.strip() for field in args.ignore_task_fields.split(",") if field.strip()
    )

    db = SessionLocal()
    try:
        _print_runtime_info(db, user_id=args.user_id)
        if args.compare:
            result = compare_legacy_task_shards(
                db,
                batch_size=args.batch_size,
                user_id=args.user_id,
                ignore_task_fields=ignore_task_fields,
            )
            db.rollback()
            print(
                "legacy_tasks={legacy_tasks} missing_tasks={missing_tasks} "
                "mismatched_tasks={mismatched_tasks} "
                "legacy_subtasks={legacy_subtasks} "
                "missing_subtasks={missing_subtasks} "
                "mismatched_subtasks={mismatched_subtasks} "
                "orphan_subtasks={orphan_subtasks} ok={ok}".format(
                    **result.__dict__,
                    ok=result.ok,
                )
            )
            if args.verbose:
                for detail in result.details:
                    fields_text = (
                        f" fields={','.join(detail.fields)}" if detail.fields else ""
                    )
                    print(
                        "detail type={row_type} id={row_id} user_id={user_id} "
                        "task_id={task_id} issue={issue}{fields_text}".format(
                            **detail.__dict__,
                            fields_text=fields_text,
                        )
                    )
            if not result.ok:
                raise SystemExit(1)
            return

        result = migrate_legacy_task_shards(
            db,
            batch_size=args.batch_size,
            dry_run=not args.execute,
            user_id=args.user_id,
        )
        if args.execute:
            db.commit()
        else:
            db.rollback()
        print(
            "tasks_seen={tasks_seen} tasks_copied={tasks_copied} "
            "subtasks_seen={subtasks_seen} subtasks_copied={subtasks_copied} "
            "orphan_subtasks={orphan_subtasks} dry_run={dry_run}".format(
                **result.__dict__,
                dry_run=not args.execute,
            )
        )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
