"""Run synchronous plugin transactions outside the ASGI event loop."""

import asyncio
import logging
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from functools import partial
from typing import Any, TypeVar

from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.services.plugin_write_coordination import configure_plugin_session
from app.services.plugin_write_errors import PluginWriteError, is_mysql_deadlock
from shared.telemetry.decorators import trace_sync

T = TypeVar("T")
logger = logging.getLogger(__name__)


async def run_plugin_operation(
    operation: Callable[..., T],
    *,
    retry_busy: bool = False,
    retry_conflicts: bool = False,
    **kwargs: Any,
) -> T:
    """Keep a transaction's session, Redis waits and cleanup in one worker."""
    return await asyncio.to_thread(
        partial(
            _run_plugin_operation,
            operation,
            kwargs,
            queued_at=time.monotonic(),
            retry_busy=retry_busy,
            retry_conflicts=retry_conflicts,
        )
    )


@trace_sync("plugin_write.operation", "backend.plugins")
def _run_plugin_operation(
    operation: Callable[..., T],
    kwargs: dict[str, Any],
    *,
    queued_at: float,
    retry_busy: bool = False,
    retry_conflicts: bool = False,
) -> T:
    started = time.monotonic()
    try:
        return run_plugin_transaction(
            lambda db: operation(db=db, **kwargs),
            get_db_session,
            retry_busy=retry_busy,
            retry_conflicts=retry_conflicts,
        )
    finally:
        logger.debug(
            "Plugin write operation=%s queue_ms=%.0f execution_ms=%.0f",
            getattr(operation, "__name__", "plugin_operation"),
            (started - queued_at) * 1000,
            (time.monotonic() - started) * 1000,
        )


def run_plugin_transaction(
    operation: Callable[[Session], T],
    session_factory: Callable[[], AbstractContextManager[Session]],
    *,
    attempts: int = 2,
    retry_busy: bool = False,
    retry_conflicts: bool = False,
) -> T:
    """Retry rolled-back work; metadata can use the shared 20-second budget."""
    deadline = time.monotonic() + 20
    last_error = None
    attempt = 0
    busy_backoff = 0.05
    while retry_conflicts or attempt < attempts:
        if last_error is not None and time.monotonic() >= deadline:
            raise last_error
        with session_factory() as db:
            configure_plugin_session(db)
            try:
                return operation(db)
            except Exception as error:
                db.rollback()
                if is_mysql_deadlock(error):
                    # MySQL aborted the whole transaction. Rebuild from a fresh
                    # session using the same contention budget as a failed CAS.
                    failure = PluginWriteError("plugin_write_conflict")
                elif isinstance(error, PluginWriteError):
                    failure = error
                else:
                    raise
                if time.monotonic() >= deadline:
                    if failure is error:
                        raise
                    raise failure from error
                if retry_busy and failure.code == "plugin_write_busy":
                    delay = busy_backoff
                    busy_backoff = min(0.25, busy_backoff * 2)
                elif failure.code == "plugin_write_conflict" and (
                    retry_conflicts or attempt + 1 < attempts
                ):
                    attempt += 1
                    delay = min(0.25, 0.01 * attempt)
                else:
                    if failure is error:
                        raise
                    raise failure from error
                last_error = failure
        time.sleep(min(delay, max(0, deadline - time.monotonic())))
    raise AssertionError("Plugin transaction retry exhausted without a result")
