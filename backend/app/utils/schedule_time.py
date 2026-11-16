# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for comparing schedule timestamps across API and database formats."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from croniter import croniter


def normalize_schedule_datetime(value: datetime) -> datetime:
    """Return a timezone-naive UTC value suitable for schedule comparisons."""
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def next_cron_datetime(
    expression: str, after: datetime, workday_only: bool = False
) -> datetime:
    """Find a timezone-aware occurrence, optionally filtering China rest days."""
    if after.tzinfo is None:
        raise ValueError("Cron reference time must include a timezone")
    iterator = croniter(expression, after)
    candidate = iterator.get_next(datetime)
    if not workday_only:
        return candidate

    from shared.utils.workday import is_china_workday

    china_timezone = ZoneInfo("Asia/Shanghai")
    while not is_china_workday(candidate):
        china_date = candidate.astimezone(china_timezone)
        next_day = (china_date + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        iterator = croniter(
            expression,
            (next_day - timedelta(microseconds=1)).astimezone(after.tzinfo),
        )
        candidate = iterator.get_next(datetime)
    return candidate
