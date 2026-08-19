# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.db import session


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
