# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for market whitelist enforcement in SubscriptionMarketService."""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.user import User
from app.schemas.subscription import (
    RentSubscriptionRequest,
    SubscriptionCreate,
    SubscriptionVisibility,
)
from app.services.subscription.market_service import subscription_market_service
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


def _create_market_subscription(
    db: Session,
    owner_user_id: int,
    team_id: int,
    whitelist_user_ids: list[int],
) -> int:
    service = SubscriptionService()
    suffix = uuid.uuid4().hex[:8]
    created = service.create_subscription(
        db,
        subscription_in=SubscriptionCreate(
            name=f"market-source-{suffix}",
            namespace="default",
            display_name="Market Source",
            task_type="collection",
            visibility=SubscriptionVisibility.MARKET,
            trigger_type="cron",
            trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
            team_id=team_id,
            prompt_template="market source prompt",
            market_whitelist_user_ids=whitelist_user_ids,
        ),
        user_id=owner_user_id,
    )
    return created.id


def test_discover_market_subscriptions_hides_non_whitelist_user(
    test_db: Session, test_user: User
):
    """Non-whitelist users should not see whitelist-protected market subscriptions."""
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    allowed_user = _create_user(
        test_db,
        username=f"allowed-{uuid.uuid4().hex[:6]}",
        email=f"allowed-{uuid.uuid4().hex[:6]}@example.com",
    )
    non_whitelist_user = _create_user(
        test_db,
        username=f"blocked-{uuid.uuid4().hex[:6]}",
        email=f"blocked-{uuid.uuid4().hex[:6]}@example.com",
    )
    subscription_id = _create_market_subscription(
        test_db,
        owner_user_id=test_user.id,
        team_id=team.id,
        whitelist_user_ids=[allowed_user.id],
    )

    items, _ = subscription_market_service.discover_market_subscriptions(
        test_db,
        user_id=non_whitelist_user.id,
    )

    assert all(item.id != subscription_id for item in items)


def test_get_market_subscription_detail_returns_403_for_non_whitelist_user(
    test_db: Session, test_user: User
):
    """Detail endpoint logic should reject non-whitelist users with 403."""
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    allowed_user = _create_user(
        test_db,
        username=f"allowed-{uuid.uuid4().hex[:6]}",
        email=f"allowed-{uuid.uuid4().hex[:6]}@example.com",
    )
    non_whitelist_user = _create_user(
        test_db,
        username=f"blocked-{uuid.uuid4().hex[:6]}",
        email=f"blocked-{uuid.uuid4().hex[:6]}@example.com",
    )
    subscription_id = _create_market_subscription(
        test_db,
        owner_user_id=test_user.id,
        team_id=team.id,
        whitelist_user_ids=[allowed_user.id],
    )

    with pytest.raises(HTTPException) as exc_info:
        subscription_market_service.get_market_subscription_detail(
            test_db,
            subscription_id=subscription_id,
            user_id=non_whitelist_user.id,
        )

    assert exc_info.value.status_code == 403


def test_rent_subscription_returns_403_for_non_whitelist_user(
    test_db: Session, test_user: User
):
    """Rent should be forbidden for non-whitelist users."""
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    allowed_user = _create_user(
        test_db,
        username=f"allowed-{uuid.uuid4().hex[:6]}",
        email=f"allowed-{uuid.uuid4().hex[:6]}@example.com",
    )
    non_whitelist_user = _create_user(
        test_db,
        username=f"blocked-{uuid.uuid4().hex[:6]}",
        email=f"blocked-{uuid.uuid4().hex[:6]}@example.com",
    )
    subscription_id = _create_market_subscription(
        test_db,
        owner_user_id=test_user.id,
        team_id=team.id,
        whitelist_user_ids=[allowed_user.id],
    )

    with pytest.raises(HTTPException) as exc_info:
        subscription_market_service.rent_subscription(
            test_db,
            source_subscription_id=subscription_id,
            renter_user_id=non_whitelist_user.id,
            request=RentSubscriptionRequest(
                name=f"rental-{uuid.uuid4().hex[:8]}",
                display_name="Rental",
                trigger_type="interval",
                trigger_config={"value": 1, "unit": "hours"},
            ),
        )

    assert exc_info.value.status_code == 403
