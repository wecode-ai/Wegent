# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metrics and safe diagnostics for SQLAlchemy connection pools."""

import logging
import multiprocessing
import sys
import threading
import time
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from opentelemetry.metrics import Observation
from sqlalchemy import event
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError
from sqlalchemy.pool import AsyncAdaptedQueuePool, QueuePool

from shared.telemetry.core import get_meter

logger = logging.getLogger(__name__)

_HIGH_UTILIZATION_THRESHOLD = 0.8
_HIGH_UTILIZATION_LOG_INTERVAL_SECONDS = 60.0
_request_path: ContextVar[str] = ContextVar("db_pool_request_path", default="")


def set_request_path(path: str) -> Token[str]:
    """Attach a request path to pool diagnostics for the current context."""
    return _request_path.set(path)


def reset_request_path(token: Token[str]) -> None:
    """Restore the previous pool diagnostic request path."""
    _request_path.reset(token)


def _diagnostic_request_path() -> str:
    return _request_path.get() or "background"


def _process_role() -> str:
    """Return a low-cardinality role for Backend and Celery processes."""
    process_name = multiprocessing.current_process().name.lower()
    command_path = sys.argv[0].replace("\\", "/").lower()
    command_name = Path(command_path).stem
    if (
        command_name == "celery"
        or "/celery/" in command_path
        or "forkpoolworker" in process_name
    ):
        return "celery"
    return "backend"


@dataclass
class _PoolRegistration:
    pool: Any
    engine_role: str
    pool_size: int
    max_overflow: int
    pool_timeout: int
    pool_recycle: int
    last_high_utilization_log: float = 0.0
    log_lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def capacity(self) -> int:
        return self.pool_size + self.max_overflow

    def checked_out(self) -> int:
        return int(self.pool.checkedout())

    def overflow(self) -> int:
        return max(0, int(self.pool.overflow()))


_registrations: dict[str, _PoolRegistration] = {}
_registrations_lock = threading.Lock()
_meter = get_meter("wegent.db.pool")
_timeout_counter = _meter.create_counter(
    "wegent.db.pool.timeouts",
    description="Number of SQLAlchemy connection pool checkout timeouts",
    unit="1",
)


def _observe(
    getter: Callable[[_PoolRegistration], int | float],
) -> Iterable[Observation]:
    with _registrations_lock:
        registrations = list(_registrations.values())
    process_role = _process_role()
    for registration in registrations:
        yield Observation(
            getter(registration),
            {
                "engine": registration.engine_role,
                "process_role": process_role,
            },
        )


_meter.create_observable_gauge(
    "wegent.db.pool.capacity",
    callbacks=[lambda _options: _observe(lambda item: item.capacity)],
    description="Configured maximum connections for this database pool",
    unit="1",
)
_meter.create_observable_gauge(
    "wegent.db.pool.checked_out",
    callbacks=[lambda _options: _observe(lambda item: item.checked_out())],
    description="Connections currently checked out from the database pool",
    unit="1",
)
_meter.create_observable_gauge(
    "wegent.db.pool.overflow",
    callbacks=[lambda _options: _observe(lambda item: item.overflow())],
    description="Overflow connections currently open for the database pool",
    unit="1",
)
_meter.create_observable_gauge(
    "wegent.db.pool.utilization",
    callbacks=[
        lambda _options: _observe(
            lambda item: item.checked_out() / item.capacity if item.capacity else 0.0
        )
    ],
    description="Ratio of checked-out connections to configured pool capacity",
    unit="1",
)


def _log_high_utilization(registration: _PoolRegistration) -> None:
    checked_out = registration.checked_out()
    utilization = checked_out / registration.capacity
    if utilization < _HIGH_UTILIZATION_THRESHOLD:
        return

    now = time.monotonic()
    with registration.log_lock:
        if (
            now - registration.last_high_utilization_log
            < _HIGH_UTILIZATION_LOG_INTERVAL_SECONDS
        ):
            return
        registration.last_high_utilization_log = now

    logger.warning(
        "Database pool utilization is high engine=%s process_role=%s "
        "request_path=%s checked_out=%d capacity=%d utilization=%.2f "
        "pool_status=%s",
        registration.engine_role,
        _process_role(),
        _diagnostic_request_path(),
        checked_out,
        registration.capacity,
        utilization,
        registration.pool.status(),
    )


def record_pool_timeout(engine_role: str, pool: Any) -> None:
    """Record a QueuePool timeout without exposing database credentials."""
    process_role = _process_role()
    _timeout_counter.add(
        1,
        {"engine": engine_role, "process_role": process_role},
    )
    logger.error(
        "Database pool checkout timed out engine=%s process_role=%s "
        "request_path=%s pool_status=%s",
        engine_role,
        process_role,
        _diagnostic_request_path(),
        pool.status(),
    )


def _log_pool_configuration(registration: _PoolRegistration) -> None:
    logger.info(
        "Database pool configured engine=%s process_role=%s pool_size=%d "
        "max_overflow=%d capacity=%d timeout_seconds=%d recycle_seconds=%d",
        registration.engine_role,
        _process_role(),
        registration.pool_size,
        registration.max_overflow,
        registration.capacity,
        registration.pool_timeout,
        registration.pool_recycle,
    )


def log_registered_pool_configurations() -> None:
    """Log every pool budget after process logging has been initialized."""
    with _registrations_lock:
        registrations = list(_registrations.values())
    for registration in registrations:
        _log_pool_configuration(registration)


class _ObservedQueuePoolMixin:
    engine_role = "unknown"

    def _do_get(self) -> Any:
        try:
            return super()._do_get()
        except SQLAlchemyTimeoutError:
            record_pool_timeout(self.engine_role, self)
            raise


class ObservedQueuePool(_ObservedQueuePoolMixin, QueuePool):
    """Synchronous QueuePool with timeout metrics and diagnostics."""

    engine_role = "sync"


class ObservedAsyncQueuePool(_ObservedQueuePoolMixin, AsyncAdaptedQueuePool):
    """Async-adapted QueuePool with timeout metrics and diagnostics."""

    engine_role = "async"


def register_pool(
    pool: Any,
    *,
    engine_role: str,
    pool_size: int,
    max_overflow: int,
    pool_timeout: int,
    pool_recycle: int,
) -> None:
    """Register a pool for gauges, high-utilization alerts, and startup logs."""
    registration = _PoolRegistration(
        pool=pool,
        engine_role=engine_role,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=pool_timeout,
        pool_recycle=pool_recycle,
    )
    with _registrations_lock:
        _registrations[engine_role] = registration

    event.listen(
        pool,
        "checkout",
        lambda _connection, _record, _proxy: _log_high_utilization(registration),
    )
    _log_pool_configuration(registration)
