# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Rental schedules share statutory workday validation with subscription writes."""

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.subscription import RentSubscriptionRequest
from app.services.subscription import helpers
from app.services.subscription.market_service import subscription_market_service


@pytest.fixture
def market_source(test_db: Session, test_user: User) -> tuple[Kind, User]:
    renter = User(
        user_name="workday-renter",
        email="workday-renter@example.com",
        password_hash="synthetic-test-hash",
        is_active=True,
    )
    source = Kind(
        user_id=test_user.id,
        kind="Subscription",
        name="workday-market-source",
        namespace="default",
        is_active=True,
        json={
            "metadata": {"name": "workday-market-source"},
            "spec": {
                "displayName": "Workday market source",
                "visibility": "market",
                "trigger": {
                    "type": "cron",
                    "cron": {"expression": "0 9 * * *", "timezone": "UTC"},
                },
                "teamRef": {"name": "workday-agent"},
                "promptTemplate": "Summarize the workday.",
            },
            "_internal": {},
        },
    )
    test_db.add_all([renter, source])
    test_db.commit()
    return source, renter


def freeze_calendar_now(monkeypatch: pytest.MonkeyPatch, now: datetime) -> None:
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return now.astimezone(tz) if tz else now.replace(tzinfo=None)

    monkeypatch.setattr(helpers, "datetime", FrozenDatetime)


def rent_request(workday_only: object) -> RentSubscriptionRequest:
    return RentSubscriptionRequest(
        name="workday-rental",
        display_name="Workday rental",
        trigger_type="cron",
        trigger_config={
            "expression": "0 9 * * *",
            "timezone": "Asia/Shanghai",
            "workday_only": workday_only,
        },
    )


@pytest.mark.parametrize("workday_only", ["false", 1, None])
def test_rental_rejects_non_boolean_workday_flag(
    test_db: Session, market_source: tuple[Kind, User], workday_only: object
):
    source, renter = market_source
    with pytest.raises(HTTPException) as raised:
        subscription_market_service.rent_subscription(
            test_db,
            source_subscription_id=source.id,
            renter_user_id=renter.id,
            request=rent_request(workday_only),
        )
    assert raised.value.status_code == 400
    assert raised.value.detail == "workday_only must be a boolean"
    assert test_db.query(Kind).filter(Kind.user_id == renter.id).count() == 0


def test_rental_reports_unsupported_calendar_year(
    test_db: Session,
    market_source: tuple[Kind, User],
    monkeypatch: pytest.MonkeyPatch,
):
    source, renter = market_source
    freeze_calendar_now(monkeypatch, datetime(2100, 1, 1, tzinfo=timezone.utc))
    with pytest.raises(HTTPException) as raised:
        subscription_market_service.rent_subscription(
            test_db,
            source_subscription_id=source.id,
            renter_user_id=renter.id,
            request=rent_request(True),
        )
    assert raised.value.status_code == 400
    assert "does not cover" in raised.value.detail
    assert test_db.query(Kind).filter(Kind.user_id == renter.id).count() == 0


def test_rental_preserves_workday_configuration_and_filtered_next_run(
    test_db: Session,
    market_source: tuple[Kind, User],
    monkeypatch: pytest.MonkeyPatch,
):
    source, renter = market_source
    freeze_calendar_now(monkeypatch, datetime(2026, 9, 30, 2, tzinfo=timezone.utc))
    request = rent_request(True)
    rented = subscription_market_service.rent_subscription(
        test_db,
        source_subscription_id=source.id,
        renter_user_id=renter.id,
        request=request,
    )
    assert rented.trigger_config == request.trigger_config
    assert rented.next_execution_time == datetime(2026, 10, 8, 1)
    stored = test_db.query(Kind).filter(Kind.id == rented.id).one()
    assert stored.json["spec"]["trigger"]["cron"] == request.trigger_config
    assert stored.json["_internal"]["next_execution_time"] == "2026-10-08T01:00:00"
