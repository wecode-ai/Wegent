# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for subscription expiration helpers."""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.subscription.helpers import is_subscription_expired


class TestIsSubscriptionExpired:
    """Tests for is_subscription_expired function."""

    def test_expired_subscription(self):
        """Test detecting expired subscription."""
        expires_at = datetime.now() - timedelta(days=1)

        result = is_subscription_expired(expires_at)

        assert result is True

    def test_not_expired_subscription(self):
        """Test detecting non-expired subscription."""
        expires_at = datetime.now() + timedelta(days=1)

        result = is_subscription_expired(expires_at)

        assert result is False

    def test_no_expiration(self):
        """Test that no expiration means not expired."""
        result = is_subscription_expired(None)

        assert result is False

    def test_exactly_at_expiration(self):
        """Test subscription exactly at expiration time."""
        current_time = datetime.now()

        result = is_subscription_expired(current_time, current_time)

        assert result is True

    def test_timezone_aware_expiration(self):
        """Test expiration with timezone-aware datetime."""
        current_time = datetime.now(timezone.utc)
        expires_at = current_time - timedelta(hours=1)

        result = is_subscription_expired(expires_at, current_time)

        assert result is True

    def test_expires_at_in_past(self):
        """Test subscription that expired yesterday."""
        expires_at = datetime.now() - timedelta(days=1, hours=2)

        result = is_subscription_expired(expires_at)

        assert result is True

    def test_expires_at_in_future(self):
        """Test subscription that expires tomorrow."""
        expires_at = datetime.now() + timedelta(days=1, hours=2)

        result = is_subscription_expired(expires_at)

        assert result is False
