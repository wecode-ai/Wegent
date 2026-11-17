# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Subscription-only bounds must not alter ordinary task history contracts."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.models.task import TaskResource
from app.services.subscription.history_window import resolve_subscription_history_limit


@pytest.mark.parametrize("requested", [None, -1, 0, 20, 10000])
def test_ordinary_task_retains_requested_limit_without_subscription_lookup(requested):
    db = Mock()
    task = SimpleNamespace(is_active=TaskResource.STATE_ACTIVE, json={})
    assert resolve_subscription_history_limit(db, task, requested) == requested
    db.query.assert_not_called()


@pytest.mark.parametrize("labels_only", [False, True])
@pytest.mark.parametrize("requested,expected", [(-1, 0), (0, 0), (20, 20), (10000, 50)])
def test_subscription_explicit_window_is_capped_without_loading_history(
    labels_only, requested, expected
):
    db = Mock()
    task = SimpleNamespace(
        is_active=(
            TaskResource.STATE_ACTIVE
            if labels_only
            else TaskResource.STATE_SUBSCRIPTION
        ),
        json={"metadata": {"labels": {"type": "subscription"}}} if labels_only else {},
    )
    assert resolve_subscription_history_limit(db, task, requested) == expected
    db.query.assert_not_called()


@pytest.mark.parametrize(
    "spec,expected",
    [
        ({"preserveHistory": False, "historyMessageCount": 20}, 0),
        ({"preserveHistory": True, "historyMessageCount": 20}, 20),
        ({"preserveHistory": True, "historyMessageCount": 10000}, 50),
        ({"preserveHistory": True}, 10),
    ],
)
def test_subscription_continuation_uses_owner_scoped_configuration(
    test_db, spec, expected
):
    from app.models.kind import Kind

    test_db.add(
        Kind(
            id=901,
            user_id=7,
            kind="Subscription",
            namespace="default",
            name="daily",
            json={"spec": spec},
        )
    )
    test_db.commit()
    task = SimpleNamespace(
        is_active=TaskResource.STATE_SUBSCRIPTION,
        user_id=7,
        json={"metadata": {"labels": {"subscriptionId": "901"}}},
    )
    assert resolve_subscription_history_limit(test_db, task) == expected
    task.user_id = 8
    assert resolve_subscription_history_limit(test_db, task) == 10
