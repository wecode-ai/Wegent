# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Mainland China statutory workday checks shared by planning and dispatch."""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from chinese_calendar import is_workday


class WorkdayCalendarError(ValueError):
    """The installed statutory calendar cannot classify the requested date."""


def is_china_workday(instant: datetime) -> bool:
    """Classify the China date of an instant; naive storage values are UTC."""
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    china_date = instant.astimezone(ZoneInfo("Asia/Shanghai")).date()
    try:
        return is_workday(china_date)
    except NotImplementedError as exc:
        raise WorkdayCalendarError(
            f"China statutory workday calendar does not cover {china_date}: {exc}"
        ) from exc
