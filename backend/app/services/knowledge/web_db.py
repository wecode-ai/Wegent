# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Database phases used by async knowledge HTTP orchestration."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from sqlalchemy.orm import Session

from app.core.bounded_executor import wait_without_abandoning
from app.db import session as db_session
from app.services.chat.storage.db import run_sync_in_executor

T = TypeVar("T")


def _execute_with_owned_session(
    operation: Callable[..., T],
    *args: Any,
) -> T:
    """Execute one synchronous phase with a worker-owned SQLAlchemy Session."""

    db: Session = db_session.SessionLocal()
    try:
        return operation(db, *args)
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


async def run_knowledge_db_phase(
    operation: Callable[..., T],
    *args: Any,
) -> T:
    """Run a knowledge DB phase in the bounded ``wegent-db`` executor."""

    task, cancellation = await wait_without_abandoning(
        run_sync_in_executor(_execute_with_owned_session, operation, *args)
    )
    try:
        result = task.result()
    except BaseException as exc:
        if cancellation is not None:
            raise cancellation from exc
        raise
    if cancellation is not None:
        raise cancellation
    return result
