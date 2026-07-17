# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for market whitelist enforcement in SubscriptionMarketService."""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.subscription_follow import SubscriptionFollow
from app.models.user import User
from app.schemas.subscription import (
    NotificationLevel,
    RentSubscriptionRequest,
    SubscriptionCreate,
    SubscriptionFollowConfig,
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


def test_rent_subscription_inherits_private_notification_for_renter(
    test_db: Session, test_user: User
):
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    renter = _create_user(
        test_db,
        username=f"renter-{uuid.uuid4().hex[:6]}",
        email=f"renter-{uuid.uuid4().hex[:6]}@example.com",
    )
    subscription_id = _create_market_subscription(
        test_db,
        owner_user_id=test_user.id,
        team_id=team.id,
        whitelist_user_ids=[renter.id],
    )
    source = test_db.query(Kind).filter(Kind.id == subscription_id).one()
    source.json["_internal"]["notification_channel_bindings"] = {
        "123": {
            "bind_private": True,
            "bind_group": True,
            "group_conversation_id": "publisher-group",
            "group_name": "Publisher group",
        }
    }
    flag_modified(source, "json")
    owner_follow = SubscriptionFollow(
        subscription_id=subscription_id,
        follower_user_id=test_user.id,
        config=SubscriptionFollowConfig(
            notification_level=NotificationLevel.NOTIFY,
            notification_channel_ids=[123],
        ).model_dump_json(),
    )
    test_db.add(owner_follow)
    test_db.commit()

    rental = subscription_market_service.rent_subscription(
        test_db,
        source_subscription_id=subscription_id,
        renter_user_id=renter.id,
        request=RentSubscriptionRequest(
            name=f"rental-{uuid.uuid4().hex[:8]}",
            display_name="Rental",
            trigger_type="interval",
            trigger_config={"value": 1, "unit": "hours"},
        ),
    )

    rental_follow = (
        test_db.query(SubscriptionFollow)
        .filter(
            SubscriptionFollow.subscription_id == rental.id,
            SubscriptionFollow.follower_user_id == renter.id,
        )
        .one()
    )
    assert SubscriptionFollowConfig.model_validate_json(
        rental_follow.config
    ).notification_channel_ids == [123]
    rental_kind = test_db.query(Kind).filter(Kind.id == rental.id).one()
    binding = rental_kind.json["_internal"]["notification_channel_bindings"]["123"]
    assert binding["bind_private"] is True
    assert binding["bind_group"] is False
    assert binding["group_conversation_id"] is None


def test_discover_market_subscriptions_handles_legacy_invalid_interval(
    test_db: Session, test_user: User
):
    """Discover should not crash when market subscription has legacy invalid interval."""
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    service = SubscriptionService()
    suffix = uuid.uuid4().hex[:8]

    created = service.create_subscription(
        test_db,
        subscription_in=SubscriptionCreate(
            name=f"market-legacy-{suffix}",
            namespace="default",
            display_name="Market Legacy Interval",
            task_type="collection",
            visibility=SubscriptionVisibility.MARKET,
            trigger_type="interval",
            trigger_config={"value": 15, "unit": "minutes"},
            team_id=team.id,
            prompt_template="market legacy interval prompt",
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

    items, _ = subscription_market_service.discover_market_subscriptions(
        test_db,
        user_id=test_user.id,
    )

    assert any(item.id == created.id for item in items)
