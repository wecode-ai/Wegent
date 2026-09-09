# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for discover subscriptions in follow service."""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from app.schemas.subscription import SubscriptionCreate, SubscriptionVisibility
from app.services.subscription.follow_service import subscription_follow_service
from app.services.subscription.service import SubscriptionService


def test_code_wiki_plan_cannot_be_shared(test_db: Session, test_user: User):
    plan = Kind(
        user_id=test_user.id,
        kind="Subscription",
        name="code-wiki-123",
        namespace="default",
        json={"_internal": {"code_wiki_id": 123}},
        is_active=True,
    )
    test_db.add(plan)
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        subscription_follow_service.invite_user(
            test_db,
            subscription_id=plan.id,
            owner_user_id=test_user.id,
            target_email="nobody@example.com",
        )

    assert exc_info.value.status_code == 409


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


def test_discover_subscriptions_handles_legacy_invalid_interval(
    test_db: Session, test_user: User
):
    """Discover should not crash when legacy interval value is less than minimum."""
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    service = SubscriptionService()
    suffix = uuid.uuid4().hex[:8]

    created = service.create_subscription(
        test_db,
        subscription_in=SubscriptionCreate(
            name=f"public-sub-{suffix}",
            namespace="default",
            display_name="Public Legacy Interval",
            task_type="collection",
            visibility=SubscriptionVisibility.PUBLIC,
            trigger_type="interval",
            trigger_config={"value": 15, "unit": "minutes"},
            team_id=team.id,
            prompt_template="legacy interval prompt",
        ),
        user_id=test_user.id,
    )

    subscription = (
        test_db.query(Kind)
        .filter(Kind.id == created.id, Kind.kind == "Subscription")
        .first()
    )
    assert subscription is not None

    subscription.json["spec"]["trigger"]["interval"]["value"] = 5
    flag_modified(subscription, "json")
    test_db.commit()

    result = subscription_follow_service.discover_subscriptions(
        test_db,
        user_id=test_user.id,
    )

    assert result.total == 1
    assert result.items[0].id == created.id
    assert result.items[0].display_name == "Public Legacy Interval"
