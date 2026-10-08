# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database-session timezone helpers."""

from datetime import UTC, datetime, timedelta, timezone

from sqlalchemy.orm import Session

MYSQL_SESSION_TIMEZONE_OFFSET = "+08:00"
MYSQL_SESSION_TIMEZONE = timezone(timedelta(hours=8))


def database_datetime_timezone(db: Session) -> timezone:
    """Return the timezone used for naive datetimes read from this session."""
    bind = db.get_bind()
    if bind is not None and bind.dialect.name == "sqlite":
        return timezone.utc
    return MYSQL_SESSION_TIMEZONE


def database_datetime_as_utc(db: Session, value: datetime) -> datetime:
    """Normalize a database-generated timestamp without shifting aware values."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=database_datetime_timezone(db))
    return value.astimezone(UTC)
