# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configured database timezone and clock helpers."""

from datetime import datetime, timezone
from typing import cast

from app.core.config import settings

MYSQL_SESSION_TIMEZONE_OFFSET = settings.DATABASE_TIMEZONE
MYSQL_SESSION_TIMEZONE = cast(
    timezone,
    datetime.strptime(MYSQL_SESSION_TIMEZONE_OFFSET, "%z").tzinfo,
)


DATABASE_DATETIME_TIMEZONE = (
    timezone.utc
    if settings.DATABASE_URL.startswith("sqlite")
    else MYSQL_SESSION_TIMEZONE
)


def database_datetime_timezone() -> timezone:
    """Return the configured naive datetime convention for the application DB."""
    return DATABASE_DATETIME_TIMEZONE


def database_datetime_now() -> datetime:
    """Return now in the configured convention for persisted naive datetimes."""
    return datetime.now(database_datetime_timezone()).replace(tzinfo=None)
