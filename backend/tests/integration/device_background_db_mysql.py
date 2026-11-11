# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Verify cross-worker Redis ACKs while real MySQL blocks device follow-ups."""

import asyncio
import time
from contextlib import suppress
from threading import Event
from uuid import uuid4

from sqlalchemy import text

from app.core.socketio import create_socketio_server
from app.db.session import engine
from app.services.user_runtime_config import user_runtime_config_service
from app.tasks.robot_queue_tasks import reconcile_device_executions


def hold_write_lock(table: str, locked: Event, release: Event) -> None:
    with engine.connect() as connection:
        connection.exec_driver_sql(f"LOCK TABLES {table} WRITE")
        try:
            locked.set()
            if not release.wait(timeout=12):
                raise TimeoutError("MySQL lock release was not requested")
        finally:
            connection.exec_driver_sql("UNLOCK TABLES")


def wait_for_blocked_query(table: str) -> None:
    deadline = time.monotonic() + 5
    with engine.connect() as connection:
        while time.monotonic() < deadline:
            waiting = connection.execute(
                text(
                    "SELECT COUNT(*) FROM information_schema.processlist "
                    "WHERE state = 'Waiting for table metadata lock' "
                    "AND info LIKE :table"
                ),
                {"table": f"%{table}%"},
            ).scalar_one()
            if waiting:
                return
            time.sleep(0.05)
    raise AssertionError(f"No MySQL query was blocked on {table}")


async def wait_for_subscription(manager, peer) -> None:
    peer._redis_connect()
    async with asyncio.timeout(5):
        while (await peer.redis.pubsub_numsub(manager.channel))[0][1] != 1:
            await asyncio.sleep(0.05)


async def verify_ack_during_sql(manager, peer, table, operation, expected) -> None:
    locked = Event()
    release = Event()
    lock_task = asyncio.create_task(
        asyncio.to_thread(hold_write_lock, table, locked, release)
    )
    job = None
    try:
        assert await asyncio.to_thread(locked.wait, 5), f"Could not lock {table}"
        job = asyncio.create_task(operation())
        await asyncio.to_thread(wait_for_blocked_query, table)
        acknowledged = asyncio.Event()
        sid = f"device-db-test:{table}"
        callback_id = manager._generate_ack_id(sid, acknowledged.set)
        await peer._publish(
            {
                "method": "callback",
                "host_id": manager.host_id,
                "sid": sid,
                "namespace": "/local-executor",
                "id": callback_id,
                "args": [],
            }
        )
        await asyncio.wait_for(acknowledged.wait(), 3)
        assert not job.done(), "The ACK must arrive while MySQL is still blocked"
    finally:
        release.set()
        try:
            await lock_task
        finally:
            if job is not None:
                assert await job == expected
    print(f"Cross-worker ACK matched while MySQL blocked {table}", flush=True)


async def main() -> None:
    manager = create_socketio_server().manager
    peer = create_socketio_server().manager
    manager.channel = peer.channel = f"socketio-device-db-test:{uuid4().hex}"
    manager.initialize()
    try:
        await wait_for_subscription(manager, peer)
        await verify_ack_during_sql(
            manager,
            peer,
            "users",
            lambda: user_runtime_config_service.sync_heartbeat_auth(
                user_id=-1, device_id="integration-device", runtime="codex"
            ),
            None,
        )
        await verify_ack_during_sql(
            manager,
            peer,
            "loop_item_executions",
            lambda: reconcile_device_executions(
                user_id=-1, device_id="integration-device", needs_confirmation_only=True
            ),
            0,
        )
    finally:
        manager.thread.cancel()
        with suppress(asyncio.CancelledError):
            await manager.thread
        for adapter in (manager, peer):
            await adapter.pubsub.aclose()
            await adapter.redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
