# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Arrange and verify real external-Issue index rows for Playwright tests."""

import argparse
import os

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.delivery import CloudProject, LoopItem


def manage_index(db: Session, project_id: str, action: str, present: bool) -> None:
    project = db.get(CloudProject, project_id)
    if project is None or project.task_provider not in {"github", "gitlab"}:
        raise ValueError("Expected the external E2E project")
    item_id = f"{project.project_key}-1"
    item = db.get(LoopItem, item_id)
    if item is not None and item.cloud_project_id != project.id:
        raise ValueError("Index belongs to another project")
    if action == "seed":
        if item is not None:
            raise ValueError("E2E index already exists")
        if present:
            # Deliberately contradict the provider's related policy: this row
            # must never grant access to an unrelated actor or mention recipient.
            db.add(
                LoopItem(
                    id=item_id,
                    cloud_project_id=project.id,
                    title="External Issue index",
                    created_by_user_id=project.created_by_user_id,
                    metadata_json={"security_level": "open"},
                )
            )
    elif action == "check":
        if (item is not None) != present:
            raise ValueError("External Issue index presence changed unexpectedly")
    elif action == "cleanup" and item is not None:
        db.delete(item)
    db.commit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["seed", "check", "cleanup"])
    parser.add_argument("project_id")
    parser.add_argument("presence", choices=["present", "absent"])
    args = parser.parse_args()
    if not os.environ.get("DATABASE_URL"):
        parser.error("DATABASE_URL must explicitly select the running E2E database")
    with SessionLocal() as db:
        manage_index(db, args.project_id, args.action, args.presence == "present")
