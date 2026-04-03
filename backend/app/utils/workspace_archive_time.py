# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Timezone helpers for workspace archive timestamps."""

from datetime import datetime, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.config import settings


def get_workspace_archive_timezone() -> tzinfo:
    """Return the configured workspace archive timezone with UTC fallback."""
    try:
        return ZoneInfo(settings.WORKSPACE_ARCHIVE_TIMEZONE)
    except ZoneInfoNotFoundError:
        return timezone.utc


def workspace_archive_now() -> datetime:
    """Return the current time in the configured workspace archive timezone."""
    return datetime.now(get_workspace_archive_timezone())


def normalize_workspace_archive_datetime(value: datetime) -> datetime:
    """Normalize archive timestamps to the configured workspace archive timezone."""
    archive_timezone = get_workspace_archive_timezone()
    if value.tzinfo is None:
        return value.replace(tzinfo=archive_timezone)
    return value.astimezone(archive_timezone)
