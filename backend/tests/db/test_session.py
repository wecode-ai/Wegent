# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.db import session
from app.db.pool_observability import ObservedQueuePool


def test_sqlite_engine_enables_concurrent_access_pragmas(
    monkeypatch,
    tmp_path,
):
    database_path = tmp_path / "concurrent.sqlite3"
    monkeypatch.setattr(
        session,
        "SQLALCHEMY_DATABASE_URL",
        f"sqlite:///{database_path}",
    )

    engine = session._create_engine()

    try:
        with engine.connect() as connection:
            journal_mode = connection.exec_driver_sql("PRAGMA journal_mode").scalar()
            busy_timeout = connection.exec_driver_sql("PRAGMA busy_timeout").scalar()

        assert journal_mode == "wal"
        assert busy_timeout == 30000
    finally:
        engine.dispose()


def test_mysql_sync_engine_uses_configured_pool_limits(monkeypatch):
    monkeypatch.setattr(
        session,
        "SQLALCHEMY_DATABASE_URL",
        "mysql+pymysql://user:pass@localhost/wegent",
    )
    monkeypatch.setattr(session.settings, "DB_POOL_SIZE", 7)
    monkeypatch.setattr(session.settings, "DB_MAX_OVERFLOW", 3)
    monkeypatch.setattr(session.settings, "DB_POOL_TIMEOUT", 11)
    monkeypatch.setattr(session.settings, "DB_POOL_RECYCLE", 1234)

    engine = session._create_engine()

    try:
        assert isinstance(engine.pool, ObservedQueuePool)
        assert engine.pool.size() == 7
        assert engine.pool._max_overflow == 3
        assert engine.pool._timeout == 11
        assert engine.pool._recycle == 1234
    finally:
        engine.dispose()
