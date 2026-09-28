# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.knowledge import CodeWikiScheduledUpdateRequest
from app.services.knowledge.code_wiki.runner import CodeWikiRunError
from app.services.knowledge.code_wiki.scheduled_update import (
    SCHEDULED_UPDATE_TIMEOUT_SECONDS,
    advance_scheduled_update,
    configure_scheduled_update,
    delete_scheduled_update,
    execute_scheduled_update,
    first_scheduled_time,
    is_code_wiki_scheduled_update,
    scheduled_update_for,
    validate_runner,
)
from app.services.subscription import subscription_service
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


def test_first_weekly_slot_never_uses_the_creation_day() -> None:
    monday_at_eight = datetime(2026, 8, 31, 0, 0, tzinfo=timezone.utc)

    result = first_scheduled_time(
        schedule(), now=monday_at_eight, defer_first_execution=True
    )

    assert result == datetime(2026, 9, 7, 1, 0)


@pytest.mark.parametrize("role", [None, "Reporter", "Developer", "Maintainer"])
def test_runner_requires_a_content_role_in_the_wiki_namespace(
    test_db: Session,
    test_user: Any,
    monkeypatch: pytest.MonkeyPatch,
    role: str | None,
) -> None:
    from app.schemas.base_role import BaseRole
    from app.services.knowledge import permission_policy
    from app.services.knowledge.code_wiki import scheduled_update

    wiki = Kind(namespace="team", user_id=test_user.id, json={"spec": {}})
    monkeypatch.setattr(
        scheduled_update,
        "validate_runner_for_source",
        lambda *args, **kwargs: test_user,
    )
    monkeypatch.setattr(
        permission_policy,
        "get_effective_role_in_group",
        lambda *args: BaseRole(role) if role else None,
    )
    monkeypatch.setattr(scheduled_update, "source_of", lambda wiki: None)
    monkeypatch.setattr(
        scheduled_update,
        "strategy_for_run",
        lambda *args, **kwargs: SimpleNamespace(strategy_id="legacy"),
    )
    monkeypatch.setattr(
        scheduled_update, "strategy_team_readiness_many", lambda *args: {}
    )

    if role in {"Developer", "Maintainer"}:
        assert validate_runner(test_db, wiki, test_user.id) == test_user
    else:
        with pytest.raises(CodeWikiRunError, match="NAMESPACE_ACCESS_DENIED"):
            validate_runner(test_db, wiki, test_user.id)


def test_first_daily_slot_is_the_next_local_calendar_day() -> None:
    result = first_scheduled_time(
        schedule(cadence="daily", interval_days=1),
        now=datetime(2026, 8, 31, 2, 0, tzinfo=timezone.utc),
        defer_first_execution=True,
    )

    assert result == datetime(2026, 9, 1, 1, 0)


def test_editing_a_daily_plan_uses_a_later_slot_today() -> None:
    result = first_scheduled_time(
        schedule(cadence="daily", interval_days=1, hour=11),
        now=datetime(2026, 8, 31, 2, 0, tzinfo=timezone.utc),
    )

    assert result == datetime(2026, 8, 31, 3, 0)


def test_editing_a_weekly_plan_uses_today_when_its_time_has_not_arrived() -> None:
    result = first_scheduled_time(
        schedule(cadence="weekly", weekday=0, hour=11),
        now=datetime(2026, 8, 31, 2, 0, tzinfo=timezone.utc),
    )

    assert result == datetime(2026, 8, 31, 3, 0)


def test_fixed_cadence_controls_interval_days() -> None:
    assert schedule(cadence="biweekly", interval_days=60).interval_days == 14


def test_first_plan_on_the_creation_day_is_deferred_by_the_service(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.knowledge.code_wiki import scheduled_update

    wiki = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        namespace="default",
        is_active=True,
        json={"spec": {"kbType": "code_wiki", "name": "Wiki"}},
    )
    test_db.add(wiki)
    test_db.flush()
    deferred: list[bool] = []

    def capture_first_time(
        data: CodeWikiScheduledUpdateRequest,
        now: datetime,
        *,
        defer_first_execution: bool,
    ) -> datetime:
        deferred.append(defer_first_execution)
        return datetime(2026, 9, 2, 1, 0)

    monkeypatch.setattr(scheduled_update, "first_scheduled_time", capture_first_time)

    configure_scheduled_update(
        test_db, knowledge_base=wiki, data=schedule(enabled=False)
    )

    assert deferred == [True]


def test_first_plan_rejects_an_invalid_timezone(
    test_db: Session, test_user: Any
) -> None:
    wiki = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        namespace="default",
        is_active=True,
        json={"spec": {"kbType": "code_wiki", "name": "Wiki"}},
    )
    test_db.add(wiki)
    test_db.flush()

    with pytest.raises(ValueError, match="Invalid IANA timezone"):
        configure_scheduled_update(
            test_db,
            knowledge_base=wiki,
            data=schedule(enabled=False, timezone="not/a-timezone"),
        )


def test_group_resource_transfer_retargets_the_scheduled_update_owner(
    test_db: Session, test_user: Any
) -> None:
    from app.services.group_service import _transfer_resources_to_owner

    wiki = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        namespace="team",
        is_active=True,
        json={"spec": {"kbType": "code_wiki", "name": "Wiki"}},
    )
    test_db.add(wiki)
    test_db.flush()
    plan = configure_scheduled_update(
        test_db, knowledge_base=wiki, data=schedule(enabled=False)
    )

    _transfer_resources_to_owner(test_db, "team", test_user.id, test_user.id + 1)
    test_db.flush()
    test_db.refresh(wiki)
    test_db.refresh(plan)

    assert wiki.user_id == test_user.id + 1
    assert plan.user_id == test_user.id + 1
    assert plan.json["spec"]["codeWikiRef"]["userId"] == test_user.id + 1
    assert scheduled_update_for(test_db, wiki).id == plan.id


def test_runner_must_be_able_to_use_the_wiki_saved_strategy(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.knowledge.code_wiki import scheduled_update

    wiki = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "kbType": "code_wiki",
                "source": {
                    "sourceType": "github",
                    "sourceUrl": "https://github.com/acme/repo",
                    "projectName": "acme/repo",
                },
                "generationStrategy": "coordinator_reviewed",
            }
        },
    )
    legacy_strategy = SimpleNamespace(strategy_id="legacy")
    stored_strategy = SimpleNamespace(strategy_id="coordinator_reviewed")
    monkeypatch.setattr(
        scheduled_update,
        "validate_runner_for_source",
        lambda *args, **kwargs: test_user,
    )
    monkeypatch.setattr(
        scheduled_update,
        "strategy_for_run",
        lambda stored_id, *, db: stored_strategy if stored_id else legacy_strategy,
    )
    monkeypatch.setattr(
        scheduled_update,
        "strategy_team_readiness_many",
        lambda db, user, resolved: {
            strategy.strategy_id: (
                "Team 'wiki/reviewer' is not available"
                if strategy.strategy_id == "coordinator_reviewed"
                else ""
            )
            for strategy in resolved
        },
    )

    with pytest.raises(CodeWikiRunError, match="MODEL_UNAVAILABLE"):
        validate_runner(test_db, wiki, test_user.id)


def test_runner_must_also_be_able_to_use_the_incremental_strategy(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.knowledge.code_wiki import scheduled_update

    wiki = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="wiki",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "kbType": "code_wiki",
                "generationStrategy": "reviewed",
                "source": {
                    "sourceType": "github",
                    "sourceUrl": "https://github.com/acme/repo",
                    "projectName": "acme/repo",
                },
            }
        },
    )
    legacy_strategy = SimpleNamespace(strategy_id="legacy")
    stored_strategy = SimpleNamespace(strategy_id="reviewed")
    monkeypatch.setattr(
        scheduled_update,
        "validate_runner_for_source",
        lambda *args, **kwargs: test_user,
    )
    monkeypatch.setattr(
        scheduled_update,
        "strategy_for_run",
        lambda stored_id, *, db: stored_strategy if stored_id else legacy_strategy,
    )
    monkeypatch.setattr(
        scheduled_update,
        "strategy_team_readiness_many",
        lambda db, user, resolved: {
            strategy.strategy_id: (
                "Team 'wiki/incremental' is not available"
                if strategy.strategy_id == "legacy"
                else ""
            )
            for strategy in resolved
        },
    )

    with pytest.raises(CodeWikiRunError, match="MODEL_UNAVAILABLE"):
        validate_runner(test_db, wiki, test_user.id)


def test_a_null_code_wiki_ref_is_not_a_scheduled_update() -> None:
    subscription = Kind(
        kind="Subscription",
        json={"spec": {"codeWikiRef": None}},
    )

    assert not is_code_wiki_scheduled_update(subscription)


def test_a_disabled_schedule_still_rejects_a_non_code_knowledge_base(
    test_db: Session, test_user: Any
) -> None:
    knowledge_base = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="notes",
        namespace="default",
        is_active=True,
        json={"spec": {"kbType": "notebook"}},
    )
    test_db.add(knowledge_base)
    test_db.flush()

    with pytest.raises(CodeWikiRunError, match="not a Code Wiki"):
        configure_scheduled_update(
            test_db, knowledge_base=knowledge_base, data=schedule(enabled=False)
        )


def test_advancing_a_late_plan_skips_missed_periods() -> None:
    plan = Kind(
        user_id=1,
        kind="Subscription",
        name="code-wiki-1",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "codeWikiRef": {
                    "id": 1,
                    "name": "wiki",
                    "namespace": "default",
                    "userId": 1,
                }
            },
            "_internal": {
                "next_execution_time": "2026-08-03T01:00:00",
                "schedule": {"interval_days": 7, "timezone": "Asia/Shanghai"},
            },
        },
    )

    advance_scheduled_update(plan, now=datetime(2026, 8, 31, 2, 0))

    assert plan.json["_internal"]["next_execution_time"] == "2026-09-07T01:00:00"


def test_advancing_preserves_local_wall_clock_across_daylight_saving_time() -> None:
    plan = Kind(
        user_id=1,
        kind="Subscription",
        name="code-wiki-1",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "codeWikiRef": {
                    "id": 1,
                    "name": "wiki",
                    "namespace": "default",
                    "userId": 1,
                }
            },
            "_internal": {
                "next_execution_time": "2026-03-02T14:00:00",
                "schedule": {"interval_days": 7, "timezone": "America/New_York"},
            },
        },
    )

    advance_scheduled_update(plan, now=datetime(2026, 3, 2, 15, 0))

    assert plan.json["_internal"]["next_execution_time"] == "2026-03-09T13:00:00"


def test_reconfiguring_reuses_the_explicitly_linked_subscription(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
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
        validate_subscription_for_read(second.json).spec.codeWikiRef.name == wiki.name
    )
    assert (
        validate_subscription_for_read(second.json).spec.codeWikiRef.namespace
        == wiki.namespace
    )
    assert (
        validate_subscription_for_read(second.json).spec.codeWikiRef.userId
        == wiki.user_id
    )
    assert (
        validate_subscription_for_read(second.json).spec.timeoutSeconds
        == SCHEDULED_UPDATE_TIMEOUT_SECONDS
    )


def test_plan_reference_must_still_match_the_complete_wiki_identity(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy.orm.attributes import flag_modified

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
    plan = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    plan.json["spec"]["codeWikiRef"]["name"] = "another-kind"
    flag_modified(plan, "json")
    test_db.commit()

    assert scheduled_update_for(test_db, wiki) is None


def test_disabling_does_not_require_the_runner_to_still_be_eligible(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
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


def test_deleting_a_scheduled_update_archives_its_plan_and_clears_the_wiki_link(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.models.subscription import BackgroundExecution
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
    plan = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=plan.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="Scheduled execution",
        prompt="Check and update Code Wiki",
    )
    test_db.add(execution)
    test_db.commit()

    delete_scheduled_update(test_db, knowledge_base=wiki)

    test_db.refresh(wiki)
    test_db.refresh(plan)
    assert scheduled_update_for(test_db, wiki) is None
    assert plan.is_active is False
    assert plan.json["_internal"]["enabled"] is False
    assert "scheduledUpdateSubscriptionId" not in wiki.json["spec"]
    assert "executionPrincipalUserId" not in wiki.json["spec"]
    assert test_db.get(BackgroundExecution, execution.id) is not None


def test_deleting_a_scheduled_update_stops_an_already_queued_worker(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus
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
    plan = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=plan.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="Scheduled execution",
        prompt="Check and update Code Wiki",
    )
    test_db.add(execution)
    test_db.commit()
    delete_scheduled_update(test_db, knowledge_base=wiki)

    execute_scheduled_update(
        test_db, subscription_id=plan.id, execution_id=execution.id
    )
    test_db.refresh(execution)

    assert execution.status == BackgroundExecutionStatus.COMPLETED_SILENT.value
    assert execution.result_summary == "Skipped because scheduled update was deleted"


def test_worker_rechecks_the_plan_after_marking_its_execution_running(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The RUNNING status commit must not admit a generation against stale locks."""
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus
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
    plan = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=plan.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="Scheduled execution",
        prompt="Check and update Code Wiki",
    )
    test_db.add(execution)
    test_db.commit()

    update_execution_status = (
        scheduled_update.subscription_service.execution_manager.update_execution_status
    )

    def delete_plan_after_running(db: Session, **kwargs: Any) -> bool:
        updated = update_execution_status(db, **kwargs)
        if kwargs["status"] == BackgroundExecutionStatus.RUNNING:
            delete_scheduled_update(db, knowledge_base=wiki)
        return updated

    monkeypatch.setattr(
        scheduled_update.subscription_service.execution_manager,
        "update_execution_status",
        delete_plan_after_running,
    )
    monkeypatch.setattr(
        scheduled_update,
        "start_run",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError()),
    )

    execute_scheduled_update(
        test_db, subscription_id=plan.id, execution_id=execution.id
    )
    test_db.refresh(execution)

    assert execution.status == BackgroundExecutionStatus.COMPLETED_SILENT.value
    assert execution.result_summary == "Skipped because scheduled update was deleted"


def test_worker_stops_when_marking_its_execution_running_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.knowledge.code_wiki import scheduled_update

    plan = Kind(
        id=12,
        kind="Subscription",
        json={"spec": {"codeWikiRef": {"id": 34}}},
    )
    db = Mock()
    db.get.side_effect = [plan, SimpleNamespace()]
    update_execution_status = Mock(return_value=False)
    start_run = Mock()
    monkeypatch.setattr(
        scheduled_update.subscription_service.execution_manager,
        "update_execution_status",
        update_execution_status,
    )
    monkeypatch.setattr(scheduled_update, "start_run", start_run)

    execute_scheduled_update(db, subscription_id=plan.id, execution_id=90)

    update_execution_status.assert_called_once()
    db.query.assert_not_called()
    start_run.assert_not_called()


def test_disabling_a_scheduled_update_stops_an_already_queued_worker(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus
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
    plan = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=plan.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="Scheduled execution",
        prompt="Check and update Code Wiki",
    )
    test_db.add(execution)
    test_db.commit()
    configure_scheduled_update(
        test_db, knowledge_base=wiki, data=schedule(enabled=False)
    )

    execute_scheduled_update(
        test_db, subscription_id=plan.id, execution_id=execution.id
    )
    test_db.refresh(execution)
    test_db.refresh(plan)

    assert execution.status == BackgroundExecutionStatus.COMPLETED_SILENT.value
    assert execution.result_summary == "Skipped because scheduled update was disabled"
    assert plan.json["_internal"]["last_execution_status"] == "COMPLETED_SILENT"


def test_a_silent_code_wiki_check_updates_the_subscription_projection(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus
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
    plan = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=plan.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="Scheduled execution",
        prompt="Check and update Code Wiki",
    )
    test_db.add(execution)
    test_db.commit()

    subscription_service.update_execution_status(
        test_db,
        execution_id=execution.id,
        status=BackgroundExecutionStatus.RUNNING,
        skip_notifications=True,
    )
    subscription_service.update_execution_status(
        test_db,
        execution_id=execution.id,
        status=BackgroundExecutionStatus.COMPLETED_SILENT,
        result_summary="repository unchanged since last run",
        skip_notifications=True,
    )
    test_db.refresh(plan)

    internal = plan.json["_internal"]
    assert internal["last_execution_status"] == "COMPLETED_SILENT"
    assert internal["last_execution_message"] == "repository unchanged since last run"
    assert internal["execution_count"] == 1
    projected = subscription_service.get_subscription(
        test_db, subscription_id=plan.id, user_id=test_user.id
    )
    assert projected.last_execution_message == "repository unchanged since last run"


def test_a_silent_ordinary_subscription_stays_out_of_subscription_statistics(
    test_db: Session, test_user: Any
) -> None:
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus

    subscription = Kind(
        user_id=test_user.id,
        kind="Subscription",
        name="ordinary",
        namespace="default",
        is_active=True,
        json={"spec": {}, "_internal": {"execution_count": 0}},
    )
    test_db.add(subscription)
    test_db.flush()
    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=subscription.id,
        task_id=0,
        trigger_type="interval",
        trigger_reason="Scheduled execution",
        prompt="Run",
    )
    test_db.add(execution)
    test_db.commit()

    subscription_service.update_execution_status(
        test_db,
        execution_id=execution.id,
        status=BackgroundExecutionStatus.RUNNING,
        skip_notifications=True,
    )
    subscription_service.update_execution_status(
        test_db,
        execution_id=execution.id,
        status=BackgroundExecutionStatus.COMPLETED_SILENT,
        result_summary="nothing to report",
        skip_notifications=True,
    )
    test_db.refresh(subscription)

    assert subscription.json["_internal"] == {"execution_count": 0}


def test_deleting_clears_a_link_to_an_already_inactive_plan(
    test_db: Session, test_user: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
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
    plan = configure_scheduled_update(test_db, knowledge_base=wiki, data=schedule())
    plan.is_active = False
    test_db.commit()

    delete_scheduled_update(test_db, knowledge_base=wiki)

    test_db.refresh(wiki)
    assert "scheduledUpdateSubscriptionId" not in wiki.json["spec"]
