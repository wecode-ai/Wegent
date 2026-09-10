# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import sqlite3
import sys
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import pool_observability


def _create_pool(*, size: int = 1, overflow: int = 0, timeout: float = 0.01):
    return pool_observability.ObservedQueuePool(
        lambda: sqlite3.connect(":memory:"),
        pool_size=size,
        max_overflow=overflow,
        timeout=timeout,
    )


@pytest.mark.unit
def test_process_role_ignores_celery_in_non_entrypoint_arguments(monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        ["pytest", "tests/core/test_celery_robot_queue_schedule.py"],
    )

    assert pool_observability._process_role() == "backend"


@pytest.mark.unit
def test_pool_timeout_records_metric_and_safe_context(monkeypatch, caplog):
    timeout_counter = MagicMock()
    monkeypatch.setattr(pool_observability, "_timeout_counter", timeout_counter)
    pool = _create_pool()
    first_connection = pool.connect()
    token = pool_observability.set_request_path("/api/tasks/create")

    try:
        with caplog.at_level(logging.ERROR):
            with pytest.raises(SQLAlchemyTimeoutError):
                pool.connect()
    finally:
        pool_observability.reset_request_path(token)
        first_connection.close()
        pool.dispose()

    timeout_counter.add.assert_called_once_with(
        1,
        {"engine": "sync", "process_role": "backend"},
    )
    assert "request_path=/api/tasks/create" in caplog.text
    assert "mysql" not in caplog.text.lower()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_async_pool_timeout_records_async_engine_role(monkeypatch):
    timeout_counter = MagicMock()
    monkeypatch.setattr(pool_observability, "_timeout_counter", timeout_counter)
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=pool_observability.ObservedAsyncQueuePool,
        pool_size=1,
        max_overflow=0,
        pool_timeout=0.01,
    )
    first_connection = await engine.connect()

    try:
        with pytest.raises(SQLAlchemyTimeoutError):
            await engine.connect()
    finally:
        await first_connection.close()
        await engine.dispose()

    timeout_counter.add.assert_called_once_with(
        1,
        {"engine": "async", "process_role": "backend"},
    )


@pytest.mark.unit
def test_high_utilization_warning_is_rate_limited(caplog):
    pool = _create_pool()
    pool_observability.register_pool(
        pool,
        engine_role="sync",
        pool_size=1,
        max_overflow=0,
        pool_timeout=1,
        pool_recycle=3600,
    )

    with caplog.at_level(logging.WARNING):
        first_connection = pool.connect()
        first_connection.close()
        second_connection = pool.connect()
        second_connection.close()
    pool.dispose()

    warning_messages = [
        record.message
        for record in caplog.records
        if "Database pool utilization is high" in record.message
    ]
    assert len(warning_messages) == 1
    assert "checked_out=1 capacity=1 utilization=1.00" in warning_messages[0]


@pytest.mark.unit
def test_registered_pool_configuration_can_be_logged_after_startup(caplog):
    pool = _create_pool(size=2, overflow=3)
    pool_observability.register_pool(
        pool,
        engine_role="sync",
        pool_size=2,
        max_overflow=3,
        pool_timeout=30,
        pool_recycle=3600,
    )

    with caplog.at_level(logging.INFO):
        pool_observability.log_registered_pool_configurations()
    pool.dispose()

    assert "pool_size=2 max_overflow=3 capacity=5" in caplog.text
