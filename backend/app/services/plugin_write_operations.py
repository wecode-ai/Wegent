"""Run synchronous plugin transactions outside the ASGI event loop."""

import asyncio
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from functools import partial
from typing import Any, TypeVar

from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.services.plugin_write_coordination import configure_plugin_session
from app.services.plugin_write_errors import PluginWriteError
from shared.telemetry.decorators import trace_sync

T = TypeVar("T")


async def run_plugin_operation(operation: Callable[..., T], **kwargs: Any) -> T:
    """Keep a transaction's session, Redis waits and cleanup in one worker."""
    return await asyncio.to_thread(partial(_run_plugin_operation, operation, kwargs))


@trace_sync("plugin_write.operation", "backend.plugins")
def _run_plugin_operation(operation: Callable[..., T], kwargs: dict[str, Any]) -> T:
    return run_plugin_transaction(lambda db: operation(db=db, **kwargs), get_db_session)


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
                if (
                    not isinstance(error, PluginWriteError)
                    or time.monotonic() >= deadline
                ):
                    raise
                if retry_busy and error.code == "plugin_write_busy":
                    delay = busy_backoff
                    busy_backoff = min(0.25, busy_backoff * 2)
                elif error.code == "plugin_write_conflict" and (
                    retry_conflicts or attempt + 1 < attempts
                ):
                    attempt += 1
                    delay = min(0.25, 0.01 * attempt)
                else:
                    raise
                last_error = error
        time.sleep(min(delay, max(0, deadline - time.monotonic())))
    raise AssertionError("Plugin transaction retry exhausted without a result")
