# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for subscription timeout schema limits."""

import pytest
from pydantic import ValidationError

from app.schemas.subscription import SubscriptionCreate, SubscriptionUpdate
from app.schemas.template import TemplateResourceSubscriptionConfig


def _subscription_create_payload(timeout_seconds: int) -> dict:
    return {
        "display_name": "Daily summary",
        "trigger_type": "cron",
        "trigger_config": {"expression": "0 9 * * *"},
        "team_id": 1,
        "prompt_template": "Summarize today's updates.",
        "timeout_seconds": timeout_seconds,
    }


def test_subscription_create_allows_24_hour_timeout():
    request = SubscriptionCreate.model_validate(
        _subscription_create_payload(timeout_seconds=24 * 60 * 60)
    )

    assert request.timeout_seconds == 24 * 60 * 60


def test_subscription_update_allows_24_hour_timeout():
    request = SubscriptionUpdate.model_validate({"timeout_seconds": 24 * 60 * 60})

    assert request.timeout_seconds == 24 * 60 * 60


def test_template_subscription_config_allows_24_hour_timeout():
    config = TemplateResourceSubscriptionConfig.model_validate(
        {
            "promptTemplate": "Process inbox message.",
            "timeoutSeconds": 24 * 60 * 60,
        }
    )

    assert config.timeoutSeconds == 24 * 60 * 60


@pytest.mark.parametrize("timeout_seconds", [0, 24 * 60 * 60 + 1])
def test_subscription_timeout_rejects_values_outside_supported_range(timeout_seconds):
    with pytest.raises(ValidationError):
        SubscriptionCreate.model_validate(
            _subscription_create_payload(timeout_seconds=timeout_seconds)
        )

    with pytest.raises(ValidationError):
        SubscriptionUpdate.model_validate({"timeout_seconds": timeout_seconds})


@pytest.mark.parametrize("timeout_seconds", [0, 24 * 60 * 60 + 1])
def test_template_subscription_config_rejects_values_outside_supported_range(
    timeout_seconds,
):
    with pytest.raises(ValidationError):
        TemplateResourceSubscriptionConfig.model_validate(
            {
                "promptTemplate": "Process inbox message.",
                "timeoutSeconds": timeout_seconds,
            }
        )
