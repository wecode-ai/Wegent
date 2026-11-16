# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Real Redis cancellation coordination and existing SQL race witnesses."""

import uuid
from typing import Any

from sqlalchemy import text

from app.db.session import SessionLocal
from app.services.chat.storage.response_cancel import (
    ABORT_SCRIPT,
    CANCEL_FLAG_TTL,
    FINALIZE_SCRIPT,
    REGISTER_SCRIPT,
    ResponseCancelCoordinator,
)


def assert_cancel_intent_protocol(case: Any) -> None:
    """Exercise the production Lua in both notification/cleanup orders."""
    flag, intent = ResponseCancelCoordinator._keys(int(uuid.uuid4().hex[:15], 16))
    client = case.redis
    case.addCleanup(client.delete, flag, intent)

    client.set(flag, "true")
    case.assertEqual(client.eval(REGISTER_SCRIPT, 2, flag, intent), 1)
    case.assertIsNone(client.get(flag))
    client.set(intent, "committing")
    case.assertEqual(client.ttl(intent), -1)
    case.assertEqual(client.eval(REGISTER_SCRIPT, 2, flag, intent), 0)

    # A foreign rollback cannot remove another transaction's intent or flag.
    case.assertEqual(client.eval(ABORT_SCRIPT, 1, intent, "foreign"), 0)
    case.assertEqual(client.get(intent), "committing")
    case.assertEqual(
        client.eval(FINALIZE_SCRIPT, 2, flag, intent, "committing", CANCEL_FLAG_TTL),
        1,
    )
    case.assertEqual(client.get(flag), "true")
    for key in (flag, intent):
        case.assertTrue(0 < client.ttl(key) <= CANCEL_FLAG_TTL)
    for _ in range(2):
        case.assertEqual(client.eval(REGISTER_SCRIPT, 2, flag, intent), 0)
        case.assertEqual(client.get(flag), "true")
    case.assertEqual(client.delete(flag, intent), 2)

    # Cleanup after COMMIT but before notify must make finalization a no-op.
    client.set(intent, "owner-exited")
    client.delete(flag, intent)
    case.assertEqual(
        client.eval(FINALIZE_SCRIPT, 2, flag, intent, "owner-exited", CANCEL_FLAG_TTL),
        0,
    )
    case.assertEqual(client.mget([flag, intent]), [None, None])

    client.set(intent, "rolled-back")
    client.set(flag, "true")
    case.assertEqual(client.eval(ABORT_SCRIPT, 1, intent, "rolled-back"), 1)
    case.assertEqual(client.get(flag), "true")
    case.assertIsNone(client.get(intent))


def cancel_is_waiting(lock_name: str) -> bool:
    with SessionLocal() as db:
        return bool(
            db.scalar(
                text(
                    """
                SELECT COUNT(*) FROM performance_schema.metadata_locks
                WHERE OBJECT_TYPE = 'USER LEVEL LOCK' AND LOCK_STATUS = 'PENDING'
                  AND OBJECT_NAME = :name
            """
                ),
                {"name": lock_name},
            )
        )


def terminal_is_waiting(task_id: int) -> bool:
    with SessionLocal() as db:
        return bool(
            db.scalar(
                text(
                    """
                SELECT COUNT(*)
                FROM performance_schema.data_lock_waits AS waiting
                JOIN performance_schema.data_locks AS requested
                  ON requested.ENGINE_LOCK_ID = waiting.REQUESTING_ENGINE_LOCK_ID
                WHERE requested.OBJECT_NAME = 'tasks'
                  AND requested.LOCK_DATA = :task_id
            """
                ),
                {"task_id": str(task_id)},
            )
        )
