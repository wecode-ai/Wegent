# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for market whitelist access helper functions."""

from app.schemas.subscription import SubscriptionVisibility
from app.services.subscription.market_access import (
    can_view_market_subscription,
    normalize_market_whitelist_user_ids,
)


def test_normalize_market_whitelist_user_ids_deduplicates_and_filters_invalid_values():
    """Normalization should keep positive unique integer IDs only."""
    normalized = normalize_market_whitelist_user_ids([3, 3, -1, 7, 0, 5])

    assert normalized == [3, 7, 5]


def test_can_view_market_subscription_allows_everyone_when_whitelist_is_empty():
    """Empty whitelist should preserve current market behavior (visible to all)."""
    assert (
        can_view_market_subscription(
            visibility=SubscriptionVisibility.MARKET,
            owner_user_id=1,
            current_user_id=8,
            whitelist_user_ids=[],
        )
        is True
    )


def test_can_view_market_subscription_forbids_non_whitelist_user():
    """Non-whitelist users should not be able to view market subscription."""
    assert (
        can_view_market_subscription(
            visibility=SubscriptionVisibility.MARKET,
            owner_user_id=1,
            current_user_id=8,
            whitelist_user_ids=[2, 3],
        )
        is False
    )
