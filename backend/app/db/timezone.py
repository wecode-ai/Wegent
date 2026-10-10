# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configured database timezone and clock helpers."""

from datetime import UTC, datetime, timezone
from typing import cast

from sqlalchemy.orm import Session

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


def database_datetime_as_utc(db: Session, value: datetime) -> datetime:
    """Normalize a database-generated timestamp without shifting aware values."""
    if value.tzinfo is None:
        bind = db.get_bind()
        source_timezone = (
            timezone.utc
            if bind is not None and bind.dialect.name == "sqlite"
            else database_datetime_timezone()
        )
        value = value.replace(tzinfo=source_timezone)
    return value.astimezone(UTC)
