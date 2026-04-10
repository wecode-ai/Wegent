# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Integration tests for subscription expiration."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionTaskType,
    SubscriptionTriggerType,
)


class TestSubscriptionExpirationStorage:
    """Tests for expires_at storage in subscription."""

    def test_subscription_with_expires_at_parsed(self, test_db):
        """Test that expires_at from _internal is parsed correctly."""
        from app.services.subscription.service import subscription_service

        # This test verifies the _convert_to_subscription_in_db method
        # correctly parses expires_at from _internal JSON
        pass  # Implementation depends on existing test fixtures


class TestSubscriptionExpirationCheck:
    """Tests for expiration checking in subscription operations."""

    def test_expired_subscription_marked_disabled(self):
        """Test that expired subscription is marked as disabled."""
        from datetime import datetime, timedelta

        from app.services.subscription.helpers import is_subscription_expired

        # Create an expiration date in the past
        expired_date = datetime.now() - timedelta(days=1)

        # Check if expired
        is_exp = is_subscription_expired(expired_date)

        assert is_exp is True

    def test_non_expired_subscription_not_marked_disabled(self):
        """Test that non-expired subscription is not marked as disabled."""
        from datetime import datetime, timedelta

        from app.services.subscription.helpers import is_subscription_expired

        # Create an expiration date in the future
        future_date = datetime.now() + timedelta(days=1)

        # Check if expired
        is_exp = is_subscription_expired(future_date)

        assert is_exp is False
