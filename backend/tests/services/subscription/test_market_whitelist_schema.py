# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for market whitelist schema fields on subscription models."""

from app.schemas.subscription import SubscriptionCreate, SubscriptionUpdate


def test_subscription_create_accepts_market_whitelist_user_ids():
    """SubscriptionCreate should accept market whitelist user IDs."""
    payload = SubscriptionCreate(
        name="market-subscription",
        display_name="Market Subscription",
        task_type="collection",
        visibility="market",
        trigger_type="cron",
        trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
        team_id=1,
        prompt_template="Daily summary",
        market_whitelist_user_ids=[2, 3],
    )

    assert payload.market_whitelist_user_ids == [2, 3]


def test_subscription_update_accepts_market_whitelist_user_ids():
    """SubscriptionUpdate should accept market whitelist user IDs."""
    payload = SubscriptionUpdate(market_whitelist_user_ids=[9, 11])

    assert payload.market_whitelist_user_ids == [9, 11]
