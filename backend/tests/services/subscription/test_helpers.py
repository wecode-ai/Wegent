# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for subscription helpers module."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.schemas.subscription import SubscriptionTriggerType
from app.services.subscription.helpers import calculate_next_execution_time


class TestCalculateNextExecutionTimeOneTime:
    """Tests for calculate_next_execution_time with ONE_TIME trigger type."""

    def test_one_time_with_timezone_converts_to_utc(self):
        """Test that one_time trigger with timezone correctly converts to UTC.

        When a user in Asia/Shanghai (UTC+8) sets execute_at='2026-01-29T09:00:00',
        the expected UTC time should be 2026-01-29T01:00:00 (9 AM - 8 hours).
        """
        trigger_config = {
            "execute_at": "2026-01-29T09:00:00",
            "timezone": "Asia/Shanghai",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        # 9 AM Shanghai time = 1 AM UTC (Shanghai is UTC+8)
        expected_utc = datetime(2026, 1, 29, 1, 0, 0)
        assert result == expected_utc

    def test_one_time_without_timezone_treats_as_utc(self):
        """Test that one_time trigger without timezone treats time as UTC."""
        trigger_config = {
            "execute_at": "2026-01-29T09:00:00",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        # Without timezone, the time is treated as UTC
        expected_utc = datetime(2026, 1, 29, 9, 0, 0)
        assert result == expected_utc

    def test_one_time_timezone_difference_is_correct(self):
        """Test that the timezone conversion produces correct 8-hour difference."""
        execute_at_str = "2026-01-29T09:00:00"

        # Without timezone
        result_no_tz = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, {"execute_at": execute_at_str}
        )

        # With Asia/Shanghai timezone
        result_with_tz = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME,
            {"execute_at": execute_at_str, "timezone": "Asia/Shanghai"},
        )

        # The difference should be exactly 8 hours
        diff = result_no_tz - result_with_tz
        assert diff.total_seconds() == 8 * 3600  # 8 hours in seconds

    def test_one_time_with_utc_timezone_no_change(self):
        """Test that UTC timezone doesn't change the time."""
        trigger_config = {
            "execute_at": "2026-01-29T09:00:00",
            "timezone": "UTC",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        expected_utc = datetime(2026, 1, 29, 9, 0, 0)
        assert result == expected_utc

    def test_one_time_with_negative_offset_timezone(self):
        """Test timezone with negative UTC offset (e.g., America/New_York)."""
        trigger_config = {
            "execute_at": "2026-01-29T09:00:00",
            "timezone": "America/New_York",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        # New York is UTC-5 in winter, so 9 AM NY = 14:00 UTC
        expected_utc = datetime(2026, 1, 29, 14, 0, 0)
        assert result == expected_utc

    def test_one_time_with_iso_format_offset(self):
        """Test that ISO format with timezone offset is handled correctly."""
        trigger_config = {
            "execute_at": "2026-01-29T09:00:00+08:00",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        # +08:00 means the time is already in UTC+8, convert to UTC
        expected_utc = datetime(2026, 1, 29, 1, 0, 0)
        assert result == expected_utc

    def test_one_time_with_invalid_timezone_falls_back_to_utc(self):
        """Test that invalid timezone falls back to treating time as UTC."""
        trigger_config = {
            "execute_at": "2026-01-29T09:00:00",
            "timezone": "Invalid/Timezone",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        # Invalid timezone should fall back to treating as UTC
        expected_utc = datetime(2026, 1, 29, 9, 0, 0)
        assert result == expected_utc

    def test_one_time_with_datetime_object_with_tzinfo(self):
        """Test that datetime object with tzinfo is converted correctly."""
        shanghai_tz = ZoneInfo("Asia/Shanghai")
        execute_at = datetime(2026, 1, 29, 9, 0, 0, tzinfo=shanghai_tz)

        trigger_config = {
            "execute_at": execute_at,
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        # 9 AM Shanghai = 1 AM UTC
        expected_utc = datetime(2026, 1, 29, 1, 0, 0)
        assert result == expected_utc

    def test_one_time_returns_naive_utc_datetime(self):
        """Test that the returned datetime is naive (no tzinfo) for database storage."""
        trigger_config = {
            "execute_at": "2026-01-29T09:00:00",
            "timezone": "Asia/Shanghai",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.ONE_TIME, trigger_config
        )

        # Result should be naive (no tzinfo) for database storage
        assert result.tzinfo is None


class TestCalculateNextExecutionTimeEvent:
    """Tests for calculate_next_execution_time with EVENT trigger type."""

    def test_event_trigger_returns_none(self):
        """Test that event trigger returns None (no scheduled execution)."""
        trigger_config = {
            "event_type": "webhook",
        }

        result = calculate_next_execution_time(
            SubscriptionTriggerType.EVENT, trigger_config
        )

        assert result is None
