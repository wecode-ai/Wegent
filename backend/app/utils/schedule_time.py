# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for comparing schedule timestamps across API and database formats."""

from datetime import datetime, timezone


def normalize_schedule_datetime(value: datetime) -> datetime:
    """Return a timezone-naive UTC value suitable for schedule comparisons."""
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)
