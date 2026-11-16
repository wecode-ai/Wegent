# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Offline mainland China statutory workdays, shared with Rust consumers."""

import json
from datetime import date, datetime, timezone
from functools import lru_cache
from importlib.resources import files
from typing import Any
from zoneinfo import ZoneInfo


class WorkdayCalendarError(ValueError):
    """The bundled statutory calendar cannot classify the requested date."""


@lru_cache(maxsize=1)
def _calendar() -> dict[str, Any]:
    resource = files("shared").joinpath("assets/calendars/china-workdays.json")
    try:
        calendar = json.loads(resource.read_text(encoding="utf-8"))
        calendar["holidays"] = frozenset(calendar["holidays"])
        calendar["workdays"] = frozenset(calendar["workdays"])
        return calendar
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise WorkdayCalendarError(
            f"Invalid China statutory workday calendar: {exc}"
        ) from exc


def is_china_workday(instant: datetime) -> bool:
    """Classify the China date of an instant; naive storage values are UTC."""
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    china_date = instant.astimezone(ZoneInfo("Asia/Shanghai")).date()
    return is_workday(china_date)


def is_workday(china_date: date) -> bool:
    """Classify an already localized mainland China calendar date."""
    calendar = _calendar()
    day = china_date.isoformat()
    if not calendar["startDate"] <= day <= calendar["endDate"]:
        raise WorkdayCalendarError(
            f"China statutory workday calendar does not cover {china_date}"
        )
    return day in calendar["workdays"] or (
        china_date.weekday() < 5 and day not in calendar["holidays"]
    )
