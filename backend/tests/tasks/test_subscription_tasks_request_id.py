# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

from app.tasks.subscription_tasks import _init_subscription_request_context


def test_init_subscription_request_context_uses_explicit_request_id():
    with patch(
        "app.tasks.subscription_tasks.set_request_context"
    ) as set_request_context:
        request_id = _init_subscription_request_context(
            subscription_id=11,
            execution_id=22,
            explicit_request_id="parent-request-id",
            source="celery",
        )

    assert request_id == "parent-request-id"
    set_request_context.assert_called_once_with("parent-request-id")


def test_init_subscription_request_context_reuses_current_context():
    with (
        patch("app.tasks.subscription_tasks.get_request_id", return_value="ctx-id"),
        patch(
            "app.tasks.subscription_tasks.set_request_context"
        ) as set_request_context,
    ):
        request_id = _init_subscription_request_context(
            subscription_id=11,
            execution_id=22,
            explicit_request_id=None,
            source="celery",
        )

    assert request_id == "ctx-id"
    set_request_context.assert_called_once_with("ctx-id")


def test_init_subscription_request_context_generates_when_missing():
    with (
        patch("app.tasks.subscription_tasks.get_request_id", return_value=None),
        patch(
            "app.tasks.subscription_tasks.set_request_context"
        ) as set_request_context,
    ):
        request_id = _init_subscription_request_context(
            subscription_id=11,
            execution_id=22,
            explicit_request_id=None,
            source="sync",
        )

    assert request_id == "sub-sync-11-22"
    set_request_context.assert_called_once_with("sub-sync-11-22")
