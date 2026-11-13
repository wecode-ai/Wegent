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


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    if (
        url.host not in {"localhost", "127.0.0.1", "mysql"}
        or url.database != "wegent_test"
    ):
        raise RuntimeError("Expected the isolated E2E MySQL database")

    from app.db.session import SessionLocal
    from app.models.kind import Kind
    from app.models.loop_item_execution import LoopItemExecution

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
        else:
            rows = db.query(LoopItemExecution).filter_by(
                executor_owner_user_id=device.user_id,
                runtime_device_id=route,
                runtime_instance_id=runtime_id,
                runtime_task_id=device_id,
            )
            if action == "clear_execution":
                rows.delete()
            elif action == "claim_execution":
                db.add(
                    LoopItemExecution(
                        executor_owner_user_id=device.user_id,
                        execution_device_id=route,
                        execution_environment="local",
                        runtime_device_id=route,
                        runtime_instance_id=runtime_id,
                        runtime_task_id=device_id,
                        status="claimed",
                        lease_expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
                        + timedelta(minutes=5),
                    )
                )
            else:
                raise ValueError(f"Unknown fixture action {action}")
            db.commit()


if __name__ == "__main__":
    main()
