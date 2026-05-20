# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import session


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
