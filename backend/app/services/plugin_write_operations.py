"""Run synchronous plugin transactions outside the ASGI event loop."""

import asyncio
from collections.abc import Callable
from functools import partial
from typing import Any, TypeVar

from app.db.session import get_db_session
from app.services.plugin_write_coordination import configure_plugin_session
from shared.telemetry.decorators import trace_sync

T = TypeVar("T")


async def run_plugin_operation(operation: Callable[..., T], **kwargs: Any) -> T:
    """Keep a transaction's session, Redis waits and cleanup in one worker."""
    return await asyncio.to_thread(partial(_run_plugin_operation, operation, kwargs))


@trace_sync("plugin_write.operation", "backend.plugins")
def _run_plugin_operation(operation: Callable[..., T], kwargs: dict[str, Any]) -> T:
    with get_db_session() as db:
        configure_plugin_session(db)
        try:
            return operation(db=db, **kwargs)
        except Exception:
            db.rollback()
            raise
