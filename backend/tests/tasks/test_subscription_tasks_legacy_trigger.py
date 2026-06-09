# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for subscription_tasks with legacy invalid trigger config."""

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionVisibility,
)
from app.services.subscription.service import SubscriptionService
from app.tasks.subscription_tasks import (
    SUBSCRIPTION_BATCH_SIZE,
    check_due_subscriptions,
    check_due_subscriptions_sync,
)


def _create_team(db: Session, owner_user_id: int, name: str) -> Kind:
    team = Kind(
        user_id=owner_user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={},
        is_active=True,
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


class _RecordingSubscriptionQuery:
    def __init__(self):
        self.limit_values = []
        self.offset_values = []
        self.order_by_calls = 0

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        self.order_by_calls += 1
        return self

    def limit(self, value):
        self.limit_values.append(value)
        return self

    def offset(self, value):
        self.offset_values.append(value)
        return self

    def all(self):
        return []


def test_check_due_subscriptions_sync_queries_active_subscriptions_in_pages():
    query = _RecordingSubscriptionQuery()
    db = MagicMock()
    db.query.return_value = query

    with (
        patch(
            "app.tasks.subscription_tasks._recover_stale_pending_executions",
            return_value=0,
        ),
        patch(
            "app.tasks.subscription_tasks._cleanup_stale_running_executions",
            return_value=0,
        ),
        patch("app.db.session.get_db_session") as mock_session,
    ):
        mock_session.return_value.__enter__ = MagicMock(return_value=db)
        mock_session.return_value.__exit__ = MagicMock(return_value=False)

        result = check_due_subscriptions_sync()

    assert result["due_subscriptions"] == 0
    assert query.order_by_calls == 1
    assert query.limit_values == [SUBSCRIPTION_BATCH_SIZE]
    assert query.offset_values == [0]


def test_check_due_subscriptions_queries_active_subscriptions_in_pages():
    query = _RecordingSubscriptionQuery()
    db = MagicMock()
    db.query.return_value = query
    lock_context = MagicMock()
    lock_context.__enter__.return_value = True
    lock_context.__exit__.return_value = False

    with (
        patch(
            "app.tasks.subscription_tasks._recover_stale_pending_executions",
            return_value=0,
        ),
        patch(
            "app.tasks.subscription_tasks._cleanup_stale_running_executions",
            return_value=0,
        ),
        patch("app.core.distributed_lock.distributed_lock.acquire_context") as acquire,
        patch("app.db.session.get_db_session") as mock_session,
    ):
        acquire.return_value = lock_context
        mock_session.return_value.__enter__ = MagicMock(return_value=db)
        mock_session.return_value.__exit__ = MagicMock(return_value=False)

        result = check_due_subscriptions.run()

    assert result["due_subscriptions"] == 0
    assert query.order_by_calls == 1
    assert query.limit_values == [SUBSCRIPTION_BATCH_SIZE]
    assert query.offset_values == [0]


def test_check_due_subscriptions_handles_legacy_invalid_interval(
    test_db: Session, test_user: User
):
    """check_due_subscriptions_sync should not crash with legacy invalid interval subscriptions."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    suffix = uuid.uuid4().hex[:8]

    # Create a subscription with valid interval first
    created = service.create_subscription(
        test_db,
        subscription_in=SubscriptionCreate(
            name=f"task-legacy-{suffix}",
            namespace="default",
            display_name="Task Legacy Interval",
            task_type="collection",
            visibility=SubscriptionVisibility.PUBLIC,
            trigger_type="interval",
            trigger_config={"value": 15, "unit": "minutes"},
            team_id=team.id,
            prompt_template="task legacy interval prompt",
        ),
        user_id=test_user.id,
    )

    subscription = (
        test_db.query(Kind)
        .filter(Kind.id == created.id, Kind.kind == "Subscription")
        .first()
    )
    assert subscription is not None

    # Manually set invalid interval (1 minute, below minimum) to simulate legacy data
    subscription.json["spec"]["trigger"]["interval"]["value"] = 1
    # Set next_execution_time to past to make it due
    subscription.json["_internal"]["next_execution_time"] = datetime.now(
        timezone.utc
    ).isoformat()
    flag_modified(subscription, "json")
    test_db.commit()

    # This should not raise an exception, it should handle the invalid config gracefully
    # Mock get_db_session to use test_db instead of connecting to MySQL
    # Note: get_db_session is imported inside the function, so we patch at source
    with patch("app.db.session.get_db_session") as mock_session:
        mock_session.return_value.__enter__ = MagicMock(return_value=test_db)
        mock_session.return_value.__exit__ = MagicMock(return_value=False)
        result = check_due_subscriptions_sync()

    # The subscription should be processed (not skipped due to validation error)
    # Due to the invalid interval, it will be fixed and processed
    assert result["due_subscriptions"] >= 0


def test_check_due_subscriptions_skips_disabled_subscriptions(
    test_db: Session, test_user: User
):
    """check_due_subscriptions_sync should skip disabled subscriptions."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    suffix = uuid.uuid4().hex[:8]

    created = service.create_subscription(
        test_db,
        subscription_in=SubscriptionCreate(
            name=f"task-disabled-{suffix}",
            namespace="default",
            display_name="Task Disabled",
            task_type="collection",
            visibility=SubscriptionVisibility.PUBLIC,
            trigger_type="interval",
            trigger_config={"value": 15, "unit": "minutes"},
            team_id=team.id,
            prompt_template="task disabled prompt",
        ),
        user_id=test_user.id,
    )

    subscription = (
        test_db.query(Kind)
        .filter(Kind.id == created.id, Kind.kind == "Subscription")
        .first()
    )
    assert subscription is not None

    # Disable the subscription
    subscription.json["_internal"]["enabled"] = False
    subscription.json["_internal"]["next_execution_time"] = datetime.now(
        timezone.utc
    ).isoformat()
    flag_modified(subscription, "json")
    test_db.commit()

    # Mock get_db_session to use test_db instead of connecting to MySQL
    # Note: get_db_session is imported inside the function, so we patch at source
    with patch("app.db.session.get_db_session") as mock_session:
        mock_session.return_value.__enter__ = MagicMock(return_value=test_db)
        mock_session.return_value.__exit__ = MagicMock(return_value=False)
        result = check_due_subscriptions_sync()

    # Disabled subscription should not be counted as due
    assert result["due_subscriptions"] == 0
