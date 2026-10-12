# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Startup timezone configuration reaches connections and datetime arithmetic."""

import json
import os
import subprocess
import sys

import pytest

STARTUP_PROBE = """
import json
from unittest.mock import patch
from app.db import session
from app.db.timezone import database_datetime_timezone

with patch.object(session, 'create_engine', wraps=session.create_engine) as sync:
    mysql = session._create_engine()
with patch.object(session, 'create_async_engine', wraps=session.create_async_engine) as async_create:
    async_mysql = session._create_async_engine()
minutes = int(database_datetime_timezone().utcoffset(None).total_seconds() / 60)
print(json.dumps({'sync': sync.call_args.kwargs['connect_args']['init_command'],
                 'async': async_create.call_args.kwargs['connect_args']['init_command'],
                 'minutes': minutes}))
"""


@pytest.mark.parametrize(
    "offset,minutes",
    [
        ("+00:00", 0),
        ("+08:00", 480),
        ("+05:30", 330),
        ("-05:30", -330),
        ("+05:45", 345),
        ("-13:59", -839),
        ("+14:00", 840),
    ],
)
def test_startup_uses_one_timezone_for_sync_async_and_clock(
    offset: str, minutes: int
) -> None:
    environment = {
        **os.environ,
        "DATABASE_TIMEZONE": offset,
        "DATABASE_URL": "mysql+pymysql://unit:unit@localhost/unit",
    }

    result = subprocess.run(
        [
            "uv",
            "run",
            "--no-project",
            "--python",
            sys.executable,
            "python",
            "-c",
            STARTUP_PROBE,
        ],
        env=environment,
        capture_output=True,
        text=True,
        check=True,
    )
    actual = json.loads(result.stdout.splitlines()[-1])

    assert actual == {
        "sync": "SET time_zone = '" + offset + "'",
        "async": "SET time_zone = '" + offset + "'",
        "minutes": minutes,
    }


def test_database_clock_does_not_require_session() -> None:
    from app.db.timezone import database_datetime_now, database_datetime_timezone

    assert database_datetime_timezone().utcoffset(None) is not None
    assert database_datetime_now().tzinfo is None


@pytest.mark.parametrize("offset", ["+08:00", "-05:30"])
def test_sqlite_clock_uses_database_url_configuration(offset: str) -> None:
    environment = {
        **os.environ,
        "DATABASE_URL": "sqlite://",
        "DATABASE_TIMEZONE": offset,
    }
    probe = "from app.db.timezone import database_datetime_timezone; print(int(database_datetime_timezone().utcoffset(None).total_seconds()))"
    result = subprocess.run(
        [
            "uv",
            "run",
            "--no-project",
            "--python",
            sys.executable,
            "python",
            "-c",
            probe,
        ],
        env=environment,
        capture_output=True,
        text=True,
        check=True,
    )

    assert result.stdout.strip() == "0"
