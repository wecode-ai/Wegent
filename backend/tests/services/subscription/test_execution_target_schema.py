# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for subscription execution target schema fields."""

from app.schemas.subscription import SubscriptionCreate, SubscriptionUpdate


def test_subscription_create_accepts_execution_target():
    """SubscriptionCreate should accept execution target configuration."""
    payload = SubscriptionCreate(
        name="device-subscription",
        display_name="Device Subscription",
        task_type="collection",
        trigger_type="cron",
        trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
        team_id=1,
        prompt_template="Run on a device",
        execution_target={
            "type": "local",
            "device_id": "local-device-1",
        },
    )

    assert payload.execution_target.type == "local"
    assert payload.execution_target.device_id == "local-device-1"


def test_subscription_update_accepts_execution_target():
    """SubscriptionUpdate should accept execution target configuration."""
    payload = SubscriptionUpdate(
        execution_target={
            "type": "cloud",
            "device_id": "cloud-device-1",
        }
    )

    assert payload.execution_target is not None
    assert payload.execution_target.type == "cloud"
    assert payload.execution_target.device_id == "cloud-device-1"
