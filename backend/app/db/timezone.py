# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database-session timezone helpers."""

from datetime import timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings


def configured_database_timezone() -> timezone:
    """Parse the configured fixed database-session UTC offset."""
    value = settings.DATABASE_SESSION_TIMEZONE.strip()
    if value in {"UTC", "Z", "+00:00"}:
        return timezone.utc
    sign = -1 if value.startswith("-") else 1
    hours_text, separator, minutes_text = value.lstrip("+-").partition(":")
    if (
        not separator
        or not hours_text.isdigit()
        or not minutes_text.isdigit()
        or int(hours_text) > 23
        or int(minutes_text) > 59
    ):
        raise ValueError("DATABASE_SESSION_TIMEZONE must be UTC or a ±HH:MM offset")
    return timezone(sign * timedelta(hours=int(hours_text), minutes=int(minutes_text)))


def configured_database_timezone_offset() -> str:
    """Return the validated session timezone in MySQL fixed-offset form."""
    offset = configured_database_timezone().utcoffset(None)
    total_minutes = int((offset or timedelta()).total_seconds() // 60)
    sign = "+" if total_minutes >= 0 else "-"
    hours, minutes = divmod(abs(total_minutes), 60)
    return f"{sign}{hours:02d}:{minutes:02d}"


def database_datetime_timezone(db: Session) -> timezone:
    """Return the timezone used for naive datetimes read from this session."""
    bind = db.get_bind()
    if bind is not None and bind.dialect.name == "sqlite":
        return timezone.utc
    return configured_database_timezone()
