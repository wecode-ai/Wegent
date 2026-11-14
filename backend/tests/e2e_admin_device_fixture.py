# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prepare real Redis and MySQL state for the admin device E2E scenario."""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from uuid import UUID

from redis import Redis
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.services.collaboration_revocation import execution_authorized
from tests.utils.collaboration import authorize_project, authorize_resource


def claim_execution(db: Session, device: Kind, task_id: str, route: str) -> None:
    """Create a claim that survives the production authorization sweep."""
    project = CloudProject(
        name=task_id,
        created_by_user_id=device.user_id,
        status="active",
    )
    authorize_project(db, project)
    authorize_resource(db, project, device)
    item = LoopItem(
        cloud_project_id=project.id,
        title=task_id,
        created_by_user_id=device.user_id,
        status="in_progress",
    )
    db.add(item)
    db.flush()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    execution = LoopItemExecution(
        cloud_project_id=project.id,
        loop_item_id=item.id,
        assigner_user_id=device.user_id,
        executor_owner_user_id=device.user_id,
        execution_device_id=route,
        execution_environment="local",
        runtime_device_id=route,
        runtime_instance_id=device.json["spec"]["runtimeInstanceId"],
        runtime_task_id=task_id,
        status="claimed",
        claimed_at=now,
        heartbeat_at=now,
        lease_expires_at=now + timedelta(minutes=5),
    )
    db.add(execution)
    db.flush()
    assert execution_authorized(db, execution), "Fixture claim must be authorized"


def clear_execution(db: Session, owner_id: int, task_id: str, route: str) -> None:
    execution = (
        db.query(LoopItemExecution)
        .filter_by(
            executor_owner_user_id=owner_id,
            runtime_device_id=route,
            runtime_task_id=task_id,
        )
        .one()
    )
    project = db.get(CloudProject, execution.cloud_project_id)
    assert project is not None and project.name == task_id
    workspace_id = project.workspace_id
    db.delete(execution)
    db.query(ResourceMember).filter_by(
        resource_type="CloudProject", resource_id=int(project.id)
    ).delete()
    for entity_type, entity_id in (
        ("project", project.id),
        ("workspace", workspace_id),
    ):
        db.query(ResourceMember).filter_by(
            resource_type="Device", entity_type=entity_type, entity_id=str(entity_id)
        ).delete()
    db.delete(project)
    workspace = db.get(Kind, workspace_id)
    if workspace is not None:
        db.delete(workspace)


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    if (
        url.host not in {"localhost", "127.0.0.1", "mysql"}
        or url.database != "wegent_test"
    ):
        raise RuntimeError("Expected the isolated E2E MySQL database")

    from app.db.session import SessionLocal

    data = json.load(sys.stdin)
    suffix = str(UUID(data["suffix"]))
    device_id = f"e2e-admin-delete-{suffix}"
    runtime_id = f"runtime-{suffix}"
    with SessionLocal() as db:
        device = (
            db.query(Kind)
            .filter_by(
                id=data["record_id"], kind="Device", namespace="default", name=device_id
            )
            .one()
        )
        assert device.json["spec"]["runtimeInstanceId"] == runtime_id
        route = f"app-record-{device.id}"
        action = data["action"]
        if action == "expire":
            redis_url = os.environ["REDIS_URL"]
            if urlsplit(redis_url).hostname not in {"localhost", "127.0.0.1", "redis"}:
                raise RuntimeError("Expected the isolated E2E Redis server")
            with Redis.from_url(redis_url) as redis:
                redis.pexpire(f"device:online:{device.user_id}:{route}", 0)
            return
        if action == "claim_execution":
            claim_execution(db, device, device_id, route)
        elif action == "clear_execution":
            clear_execution(db, device.user_id, device_id, route)
        else:
            raise ValueError(f"Unknown fixture action {action}")
        db.commit()


if __name__ == "__main__":
    main()
