# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Arrange disposable project-event credentials and polling work for E2E."""

import argparse
import json
import os
from datetime import timedelta

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.delivery import ProjectIncomingHook
from app.services.connector_connections import connector_connection_service
from app.services.project_automation_domain import utcnow
from app.tasks.project_automation_tasks import (
    check_due_project_event_subscriptions,
)


def seed_connection(db: Session, user_id: int, slug: str) -> None:
    token = os.environ.get("E2E_PROVIDER_TOKEN")
    if not token:
        raise ValueError("E2E_PROVIDER_TOKEN must select the fixture credential")
    existing = connector_connection_service.get(db, slug=slug, user_id=user_id)
    if existing is not None:
        raise ValueError("E2E connector credential already exists")
    connection = connector_connection_service.save_oauth_connection(
        db,
        slug=slug,
        user_id=user_id,
        access_token=token,
        refresh_token=None,
        token_type="bearer",
        granted_scopes=["repo"],
        external_account_name="quality-e2e",
        expires_at=None,
    )
    if connection is None or connection.status != "connected":
        raise ValueError("E2E connector credential was not persisted")


def trigger_polling(db: Session, hook_id: str) -> int:
    hook = db.get(ProjectIncomingHook, hook_id)
    if hook is None or hook.status != "active":
        raise ValueError("E2E event subscription is not active")
    hook.due_at = utcnow() - timedelta(seconds=1)
    hook.version += 1
    db.commit()
    result = check_due_project_event_subscriptions.apply_async(expires=60)
    return int(result.get(timeout=60))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    seed = commands.add_parser("seed")
    seed.add_argument("user_id", type=int)
    seed.add_argument("slug")
    trigger = commands.add_parser("trigger")
    trigger.add_argument("hook_id")
    cleanup = commands.add_parser("cleanup")
    cleanup.add_argument("user_id", type=int)
    cleanup.add_argument("slug")
    args = parser.parse_args()
    if not os.environ.get("DATABASE_URL"):
        parser.error("DATABASE_URL must explicitly select the running E2E database")
    with SessionLocal() as db:
        if args.action == "seed":
            seed_connection(db, args.user_id, args.slug)
        elif args.action == "trigger":
            print(json.dumps({"processed": trigger_polling(db, args.hook_id)}))
        else:
            connector_connection_service.disconnect(
                db,
                slug=args.slug,
                user_id=args.user_id,
            )


if __name__ == "__main__":
    main()
