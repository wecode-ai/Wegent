# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.knowledge import CodeWikiScheduledUpdateRequest
from app.services.knowledge.code_wiki.scheduled_update import (
    SCHEDULED_UPDATE_TIMEOUT_SECONDS,
    advance_scheduled_update,
    configure_scheduled_update,
    first_scheduled_time,
    is_code_wiki_scheduled_update,
    scheduled_update_for,
)
from app.services.subscription.helpers import validate_subscription_for_read


def schedule(**overrides: Any) -> CodeWikiScheduledUpdateRequest:
    values: dict[str, Any] = {
        "enabled": True,
        "cadence": "weekly",
        "interval_days": 7,
        "weekday": 0,
        "hour": 9,
        "minute": 0,
        "timezone": "Asia/Shanghai",
    }
    values.update(overrides)
    return CodeWikiScheduledUpdateRequest(**values)


def test_first_weekly_slot_never_uses_the_creation_day():
    monday_at_eight = datetime(2026, 8, 31, 0, 0, tzinfo=timezone.utc)

    result = first_scheduled_time(schedule(), now=monday_at_eight)

    assert result == datetime(2026, 9, 7, 1, 0)


def test_first_daily_slot_is_the_next_local_calendar_day():
    result = first_scheduled_time(
        schedule(cadence="daily", interval_days=1),
        now=datetime(2026, 8, 31, 2, 0, tzinfo=timezone.utc),
    )

    assert result == datetime(2026, 9, 1, 1, 0)


def test_fixed_cadence_controls_interval_days():
    assert schedule(cadence="biweekly", interval_days=60).interval_days == 14


def test_a_null_code_wiki_ref_is_not_a_scheduled_update() -> None:
    subscription = Kind(
        kind="Subscription",
        json={"spec": {"codeWikiRef": None}},
    )

    assert not is_code_wiki_scheduled_update(subscription)


def test_advancing_a_late_plan_skips_missed_periods():
    plan = Kind(
        user_id=1,
        kind="Subscription",
        name="code-wiki-1",
        namespace="default",
        is_active=True,
        json={
            "spec": {"codeWikiRef": {"id": 1}},
            "_internal": {
                "next_execution_time": "2026-08-03T01:00:00",
                "schedule": {"interval_days": 7, "timezone": "Asia/Shanghai"},
            },
        },
    )

    advance_scheduled_update(plan, now=datetime(2026, 8, 31, 2, 0))

    assert plan.json["_internal"]["next_execution_time"] == "2026-09-07T01:00:00"


def test_advancing_preserves_local_wall_clock_across_daylight_saving_time():
    plan = Kind(
        user_id=1,
        kind="Subscription",
        name="code-wiki-1",
        namespace="default",
        is_active=True,
        json={
            "spec": {"codeWikiRef": {"id": 1}},
            "_internal": {
                "next_execution_time": "2026-03-02T14:00:00",
                "schedule": {"interval_days": 7, "timezone": "America/New_York"},
            },
        },
    )

    advance_scheduled_update(plan, now=datetime(2026, 3, 2, 15, 0))

    assert plan.json["_internal"]["next_execution_time"] == "2026-03-09T13:00:00"


def test_reconfiguring_reuses_the_explicitly_linked_subscription(
    test_db: Session, test_user, monkeypatch
):
    from app.services.knowledge.code_wiki import scheduled_update

    wiki = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        namespace="default",
        is_active=True,
        json={"spec": {"kbType": "code_wiki"}},
    )
    test_db.add(wiki)
    test_db.flush()
    monkeypatch.setattr(
        scheduled_update,
        "validate_runner",
        lambda db, knowledge_base, user_id: test_user,
    )

    first = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    second = configure_scheduled_update(
        test_db,
        knowledge_base=wiki,
        data=schedule(enabled=False, cadence="biweekly"),
    )

    test_db.refresh(wiki)
    assert second.id == first.id
    assert wiki.json["spec"]["scheduledUpdateSubscriptionId"] == first.id
    assert scheduled_update_for(test_db, wiki).json["_internal"]["enabled"] is False
    assert (
        scheduled_update_for(test_db, wiki).json["_internal"]["schedule"][
            "interval_days"
        ]
        == 14
    )
    assert validate_subscription_for_read(second.json).spec.codeWikiRef.id == wiki.id
    assert (
        validate_subscription_for_read(second.json).spec.timeoutSeconds
        == SCHEDULED_UPDATE_TIMEOUT_SECONDS
    )


def test_disabling_does_not_require_the_runner_to_still_be_eligible(
    test_db: Session, test_user, monkeypatch
):
    from app.services.knowledge.code_wiki import scheduled_update

    wiki = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        namespace="default",
        is_active=True,
        json={"spec": {"kbType": "code_wiki"}},
    )
    test_db.add(wiki)
    test_db.flush()
    monkeypatch.setattr(
        scheduled_update,
        "validate_runner",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError()),
    )

    configured = configure_scheduled_update(
        test_db, knowledge_base=wiki, data=schedule(enabled=False)
    )

    assert configured.json["_internal"]["enabled"] is False
