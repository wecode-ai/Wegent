# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal subscription creation recursion guard."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.api.endpoints.internal.subscriptions import create_subscription_internal
from app.schemas.subscription import SubscriptionCreate


def _build_subscription_create_payload() -> SubscriptionCreate:
    """Build a minimal valid subscription creation payload."""
    return SubscriptionCreate(
        name="sub-test-guard",
        namespace="default",
        display_name="Test Guard",
        trigger_type="cron",
        trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
        team_id=1,
        prompt_template="test",
    )


def test_internal_create_rejects_subscription_context_header():
    """Internal API should reject creation when request comes from subscription context."""
    payload = _build_subscription_create_payload()

    with patch(
        "app.api.endpoints.internal.subscriptions.subscription_service.create_subscription"
    ) as mock_create:
        with pytest.raises(HTTPException) as exc_info:
            create_subscription_internal(
                subscription_in=payload,
                user_id=123,
                x_wegent_subscription_context="true",
                db=MagicMock(),
            )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "订阅任务中不允许创建订阅任务"
    mock_create.assert_not_called()


def test_internal_create_allows_non_subscription_context():
    """Internal API should continue to create subscriptions in normal context."""
    payload = _build_subscription_create_payload()
    expected_result = MagicMock()

    with patch(
        "app.api.endpoints.internal.subscriptions.subscription_service.create_subscription",
        return_value=expected_result,
    ) as mock_create:
        result = create_subscription_internal(
            subscription_in=payload,
            user_id=123,
            x_wegent_subscription_context="false",
            db=MagicMock(),
        )

    assert result is expected_result
    mock_create.assert_called_once()


def test_internal_create_forces_disabled_for_chat_shell_requests():
    """Internal API should force enabled=False for chat-shell initiated creation."""
    payload = _build_subscription_create_payload()
    payload.enabled = True
    expected_result = MagicMock()

    with patch(
        "app.api.endpoints.internal.subscriptions.subscription_service.create_subscription",
        return_value=expected_result,
    ) as mock_create:
        result = create_subscription_internal(
            subscription_in=payload,
            user_id=123,
            x_wegent_subscription_context="false",
            x_service_name="chat-shell",
            db=MagicMock(),
        )

    assert result is expected_result
    sent_subscription = mock_create.call_args.kwargs["subscription_in"]
    assert sent_subscription.enabled is False
