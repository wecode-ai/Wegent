# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for execution list with legacy invalid subscription trigger."""

import uuid

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.subscription import (
    BackgroundExecutionStatus,
    SubscriptionCreate,
    SubscriptionVisibility,
)
from app.services.subscription.service import SubscriptionService


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


def test_list_executions_handles_legacy_invalid_interval(
    test_db: Session, test_user: User
):
    """Execution timeline should not crash with legacy invalid interval subscriptions."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    suffix = uuid.uuid4().hex[:8]

    created = service.create_subscription(
        test_db,
        subscription_in=SubscriptionCreate(
            name=f"exec-legacy-{suffix}",
            namespace="default",
            display_name="Execution Legacy Interval",
            task_type="collection",
            visibility=SubscriptionVisibility.PUBLIC,
            trigger_type="interval",
            trigger_config={"value": 15, "unit": "minutes"},
            team_id=team.id,
            prompt_template="execution legacy interval prompt",
        ),
        user_id=test_user.id,
    )

    subscription = (
        test_db.query(Kind)
        .filter(Kind.id == created.id, Kind.kind == "Subscription")
        .first()
    )
    assert subscription is not None

    subscription.json["spec"]["trigger"]["interval"]["value"] = 1
    flag_modified(subscription, "json")
    test_db.commit()

    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=created.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="test",
        prompt="test prompt",
        status=BackgroundExecutionStatus.COMPLETED.value,
        result_summary="ok",
        error_message="",
    )
    test_db.add(execution)
    test_db.commit()

    items, total = service.list_executions(
        db=test_db,
        user_id=test_user.id,
        skip=0,
        limit=20,
        include_silent=True,
    )

    assert total == 1
    assert len(items) == 1
    assert items[0].subscription_id == created.id
    assert items[0].subscription_display_name == "Execution Legacy Interval"
