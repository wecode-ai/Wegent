# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for market whitelist persistence in SubscriptionService."""

import uuid

from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.user import User
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionUpdate,
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


def _create_user(
    db: Session, username: str, email: str, is_active: bool = True
) -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash("password"),
        email=email,
        is_active=is_active,
        git_info=None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _build_create_payload(
    team_id: int, whitelist_user_ids: list[int]
) -> SubscriptionCreate:
    suffix = uuid.uuid4().hex[:8]
    return SubscriptionCreate(
        name=f"market-whitelist-{suffix}",
        namespace="default",
        display_name="Market Whitelist Subscription",
        task_type="collection",
        visibility=SubscriptionVisibility.MARKET,
        trigger_type="cron",
        trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
        team_id=team_id,
        prompt_template="daily market update",
        market_whitelist_user_ids=whitelist_user_ids,
    )


def test_create_subscription_persists_filtered_market_whitelist_ids(
    test_db: Session, test_user: User
):
    """Create should persist only existing active users in market whitelist."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    active_user = _create_user(
        test_db,
        username=f"active-{uuid.uuid4().hex[:6]}",
        email=f"active-{uuid.uuid4().hex[:6]}@example.com",
        is_active=True,
    )
    inactive_user = _create_user(
        test_db,
        username=f"inactive-{uuid.uuid4().hex[:6]}",
        email=f"inactive-{uuid.uuid4().hex[:6]}@example.com",
        is_active=False,
    )

    created = service.create_subscription(
        test_db,
        subscription_in=_build_create_payload(
            team.id,
            [active_user.id, inactive_user.id, 999999, active_user.id],
        ),
        user_id=test_user.id,
    )

    assert created.market_whitelist_user_ids == [active_user.id]

    created_kind = test_db.query(Kind).filter(Kind.id == created.id).first()
    assert created_kind is not None
    assert created_kind.json["_internal"]["market_whitelist_user_ids"] == [
        active_user.id
    ]


def test_update_subscription_persists_filtered_market_whitelist_ids(
    test_db: Session, test_user: User
):
    """Update should overwrite market whitelist IDs with filtered values."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    allowed_user = _create_user(
        test_db,
        username=f"allowed-{uuid.uuid4().hex[:6]}",
        email=f"allowed-{uuid.uuid4().hex[:6]}@example.com",
        is_active=True,
    )

    created = service.create_subscription(
        test_db,
        subscription_in=_build_create_payload(team.id, []),
        user_id=test_user.id,
    )

    updated = service.update_subscription(
        test_db,
        subscription_id=created.id,
        subscription_in=SubscriptionUpdate(
            market_whitelist_user_ids=[allowed_user.id, 1000000, allowed_user.id]
        ),
        user_id=test_user.id,
    )

    assert updated.market_whitelist_user_ids == [allowed_user.id]

    updated_kind = test_db.query(Kind).filter(Kind.id == created.id).first()
    assert updated_kind is not None
    assert updated_kind.json["_internal"]["market_whitelist_user_ids"] == [
        allowed_user.id
    ]
