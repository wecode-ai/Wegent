# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import session
from app.db.pool_observability import ObservedAsyncQueuePool


@pytest.mark.unit
@pytest.mark.parametrize(
    ("database_url", "expected_async_url"),
    [
        (
            "mysql+pymysql://user:pa%40ss@localhost/wegent?charset=utf8mb4",
            "mysql+asyncmy://user:pa%40ss@localhost/wegent?charset=utf8mb4",
        ),
        (
            "mysql://user:pass@localhost/wegent",
            "mysql+asyncmy://user:pass@localhost/wegent",
        ),
        (
            "mysql+asyncmy://user:pass@localhost/wegent",
            "mysql+asyncmy://user:pass@localhost/wegent",
        ),
        (
            "mysql+asyncmy+pymysql://user:pass@localhost/wegent",
            "mysql+asyncmy://user:pass@localhost/wegent",
        ),
        (
            "sqlite:///test.db",
            "sqlite+aiosqlite:///test.db",
        ),
    ],
)
def test_get_async_database_url_normalizes_driver(
    monkeypatch, database_url, expected_async_url
):
    monkeypatch.setattr(session, "SQLALCHEMY_DATABASE_URL", database_url)

    assert session._get_async_database_url() == expected_async_url


@pytest.mark.unit
def test_configure_async_engine_forces_asyncmy_ping_reconnect_argument():
    engine = create_async_engine("mysql+asyncmy://user:pass@localhost/wegent")
    engine.sync_engine.dialect._send_false_to_ping = False

    session._configure_async_engine_dialect(engine)

    assert engine.sync_engine.dialect._send_false_to_ping is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_mysql_async_engine_uses_independent_pool_limits(monkeypatch):
    monkeypatch.setattr(
        session,
        "SQLALCHEMY_DATABASE_URL",
        "mysql+pymysql://user:pass@localhost/wegent",
    )
    monkeypatch.setattr(session.settings, "DB_ASYNC_POOL_SIZE", 4)
    monkeypatch.setattr(session.settings, "DB_ASYNC_MAX_OVERFLOW", 2)
    monkeypatch.setattr(session.settings, "DB_POOL_TIMEOUT", 13)
    monkeypatch.setattr(session.settings, "DB_POOL_RECYCLE", 2345)

    engine = session._create_async_engine()

    try:
        assert isinstance(engine.pool, ObservedAsyncQueuePool)
        assert engine.pool.size() == 4
        assert engine.pool._max_overflow == 2
        assert engine.pool._timeout == 13
        assert engine.pool._recycle == 2345
    finally:
        await engine.dispose()
