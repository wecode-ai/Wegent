# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.knowledge import CodeWikiAutomaticUpdateRequest
from app.services.knowledge.code_wiki.automatic_update import (
    advance_plan,
    configure_plan,
    next_time,
    plan_for,
)
from app.services.subscription.helpers import validate_subscription_for_read


def schedule(**overrides) -> CodeWikiAutomaticUpdateRequest:
    values = {
        "enabled": True,
        "interval_days": 7,
        "weekday": 0,
        "hour": 9,
        "minute": 0,
        "timezone": "Asia/Shanghai",
    }
    values.update(overrides)
    return CodeWikiAutomaticUpdateRequest(**values)


def test_a_passed_wall_clock_slot_waits_for_the_next_period():
    monday_at_ten = datetime(2026, 8, 31, 2, 0, tzinfo=timezone.utc)

    result = next_time(schedule(), now=monday_at_ten)

    assert result == datetime(2026, 9, 7, 1, 0)


def test_advancing_a_late_plan_skips_missed_periods():
    plan = Kind(
        user_id=1,
        kind="Subscription",
        name="code-wiki-1",
        namespace="default",
        is_active=True,
        json={
            "_internal": {
                "code_wiki_id": 1,
                "next_execution_time": "2026-08-03T01:00:00",
                "schedule": {"interval_days": 7, "timezone": "Asia/Shanghai"},
            }
        },
    )

    advance_plan(plan, now=datetime(2026, 8, 31, 2, 0))

    assert plan.json["_internal"]["next_execution_time"] == "2026-09-07T01:00:00"


def test_advancing_preserves_local_wall_clock_across_daylight_saving_time():
    plan = Kind(
        user_id=1,
        kind="Subscription",
        name="code-wiki-1",
        namespace="default",
        is_active=True,
        json={
            "_internal": {
                "code_wiki_id": 1,
                # 09:00 America/New_York before daylight saving time starts.
                "next_execution_time": "2026-03-02T14:00:00",
                "schedule": {"interval_days": 7, "timezone": "America/New_York"},
            }
        },
    )

    advance_plan(plan, now=datetime(2026, 3, 2, 15, 0))

    # The following Monday is still 09:00 locally, but its UTC offset has changed.
    assert plan.json["_internal"]["next_execution_time"] == "2026-03-09T13:00:00"


def test_reconfiguring_reuses_the_wikis_single_plan(
    test_db: Session, test_user, monkeypatch
):
    from app.services.knowledge.code_wiki import automatic_update

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
        automatic_update,
        "validate_runner",
        lambda db, knowledge_base, user_id: test_user,
    )

    first = configure_plan(test_db, knowledge_base=wiki, data=schedule())
    second = configure_plan(
        test_db, knowledge_base=wiki, data=schedule(enabled=False, interval_days=14)
    )

    assert second.id == first.id
    assert plan_for(test_db, wiki.id).json["_internal"]["enabled"] is False
    assert (
        plan_for(test_db, wiki.id).json["_internal"]["schedule"]["interval_days"] == 14
    )
    assert validate_subscription_for_read(second.json).spec.codeWikiRef.id == wiki.id
