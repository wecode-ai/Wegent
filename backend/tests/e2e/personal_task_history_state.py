"""Seed and remove task history owned by an isolated E2E account."""

import json
import os
import sys
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, insert, select

from app.db.session import SessionLocal
from app.models.task import TaskResource
from app.models.user import User


def task_row(user_id: int, prefix: str, sequence: int) -> dict[str, Any]:
    name = f"{prefix}-task-{sequence}"
    created_at = datetime(2026, 1, 1, 12) - timedelta(seconds=sequence)
    return {
        "user_id": user_id,
        "kind": "Task",
        "name": name,
        "namespace": "default",
        "json": {"spec": {"title": name}, "status": {"status": "COMPLETED"}},
        "is_active": 1,
        "created_at": created_at,
        "updated_at": created_at,
        "project_id": 0,
        "client_origin": "frontend",
        "is_group_chat": False,
    }


def seed_rows(user_id: int, prefix: str, count: int) -> list[dict[str, Any]]:
    rows = []
    for sequence in range(1, count + 1):
        row = task_row(user_id, prefix, sequence)
        rows.append(row)
        if sequence % 100 == 0:
            # Gaps prove that the history cap counts tasks rather than ID values.
            rows.append({**row, "kind": "Workspace", "name": f"{prefix}-ws-{sequence}"})
    for sequence, fields in enumerate(
        [
            {"namespace": "system"},
            {"is_group_chat": True},
            {"is_active": 0},
            {"client_origin": "wework"},
        ],
        start=count + 1,
    ):
        rows.append({**task_row(user_id, prefix, sequence), **fields})
    return rows


def main() -> None:
    if not os.environ.get("DATABASE_URL"):
        raise RuntimeError("Personal history E2E requires an isolated DATABASE_URL")
    request = json.load(sys.stdin)
    prefix = request["prefix"]
    if not prefix.startswith("e2e-personal-history-"):
        raise ValueError("Only E2E-owned task history may be changed")
    with SessionLocal() as db:
        user = db.get(User, request["user_id"])
        if user is None or user.user_name != prefix:
            raise ValueError("The fixture must own the requested account")
        owned = (
            TaskResource.user_id == user.id,
            TaskResource.name.startswith(prefix, autoescape=True),
        )
        if request["operation"] == "cleanup":
            db.execute(delete(TaskResource).where(*owned))
            db.commit()
            print(json.dumps({"cleaned": True}))
            return
        count = request.get("count", 10_005)
        if request["operation"] != "seed" or not 1 <= count <= 10_005:
            raise ValueError("Invalid history fixture operation or size")
        db.execute(insert(TaskResource), seed_rows(user.id, prefix, count))
        db.commit()
        ids = list(
            db.scalars(
                select(TaskResource.id)
                .where(
                    *owned,
                    TaskResource.kind == "Task",
                    TaskResource.namespace == "default",
                    TaskResource.is_active == 1,
                    TaskResource.is_group_chat.is_(False),
                    TaskResource.client_origin == "frontend",
                )
                .order_by(TaskResource.id.desc())
            )
        )
        if len(ids) != count:
            raise AssertionError("Unexpected fixture task count")
        print(
            json.dumps(
                {
                    "first_page": ids[:100],
                    "second_page": ids[100:200],
                    "last_cursor_id": ids[9_998] if count >= 10_000 else None,
                    "last_visible_id": ids[9_999] if count >= 10_000 else None,
                }
            )
        )


if __name__ == "__main__":
    main()
