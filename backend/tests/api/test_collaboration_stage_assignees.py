# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""A collaboration round validates every constrained target before publishing."""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.endpoints import loop_item_executions
from app.models.delivery import LoopItem, LoopItemComment, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.project_chat import (
    LoopItemExecutionBatchCreate,
    LoopItemExecutionBatchItem,
)
from tests.api.test_loop_item_executions_api import collaboration_dispatch  # noqa: F401
from tests.utils.collaboration import authorize_resource


def _values(fixture: SimpleNamespace, test_user: User) -> LoopItemExecutionBatchCreate:
    return LoopItemExecutionBatchCreate(
        loop_item_id=fixture.parent.id,
        dispatch_id="dispatch-1",
        round_id="stage-round",
        manager_runtime_task_id="manager-runtime-1-manager-initial",
        manager_agent_id=fixture.manager.id,
        items=[
            LoopItemExecutionBatchItem(
                assignment_id="human-assignment",
                title="Business approval",
                instructions="Review the business evidence.",
                assignee_type="human",
                assignee_id=str(test_user.id),
                workflow_stage_id="approval",
            ),
            LoopItemExecutionBatchItem(
                assignment_id="agent-assignment",
                title="Technical review",
                instructions="Review the implementation evidence.",
                assignee_type="agent",
                assignee_id=fixture.worker.id,
                workflow_stage_id="review",
            ),
        ],
    )


def _constrain(fixture: SimpleNamespace, test_user: User) -> None:
    fixture.parent.metadata_json = {
        **fixture.parent.metadata_json,
        "workflow": {
            "current_stage_id": "approval",
            "nodes": [
                {
                    "id": "approval",
                    "name": "Business approval",
                    "required_assignee_type": "user",
                    "required_assignee_id": str(test_user.id),
                },
                {
                    "id": "review",
                    "name": "Technical review",
                    "required_assignee_type": "user",
                    "required_assignee_id": str(test_user.id),
                },
            ],
        },
    }


def _counts(db: Session) -> tuple[int, ...]:
    return tuple(
        db.query(model).count()
        for model in (
            LoopItem,
            LoopItemComment,
            LoopItemExecution,
            ProjectChatMessage,
            WeworkNotification,
        )
    )


@pytest.mark.parametrize(
    "worker_reference",
    ["canonical", "team_alias", "missing_team_alias", "missing_agent"],
)
def test_later_stage_mismatch_has_no_partial_assignment_or_notification(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
    worker_reference: str,
) -> None:
    fixture = collaboration_dispatch
    _constrain(fixture, test_user)
    values = _values(fixture, test_user)
    if worker_reference != "canonical":
        for agent in (fixture.manager, fixture.worker, fixture.reviewer):
            agent.metadata_json = {**agent.metadata_json, "runtime": "codex"}
    if worker_reference == "team_alias":
        values.items[1].assignee_id = str(
            fixture.worker.metadata_json["wegent_team_id"]
        )
    elif worker_reference == "missing_team_alias":
        values.items[1].assignee_id = "9999999"
    elif worker_reference == "missing_agent":
        values.items[1].assignee_id = "nonexistent-agent"
    test_db.commit()
    before_counts = _counts(test_db)
    before_agents = test_db.query(ProjectChatAgent).count()
    before_metadata = deepcopy(fixture.parent.metadata_json)
    before_version = fixture.parent.version
    notifications: list[dict] = []
    monkeypatch.setattr(
        loop_item_executions,
        "notify_collaboration_human_assignment",
        lambda _db, **values: notifications.append(values),
    )

    with pytest.raises(HTTPException) as error:
        loop_item_executions.enqueue_execution_batch(
            fixture.project.id, values, test_db, test_user
        )

    assert error.value.status_code == 422
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["issue_version"] == before_version
    assert error.value.detail["stage_id"] == "review"
    assert error.value.detail["expected_assignee"] == {
        "assignee_type": "user",
        "assignee_id": str(test_user.id),
    }
    assert error.value.detail["actual_assignee"] == {
        "assignee_type": "agent",
        "assignee_id": (
            values.items[1].assignee_id
            if worker_reference.startswith("missing_")
            else fixture.worker.id
        ),
    }
    assert notifications == []
    assert _counts(test_db) == before_counts
    assert test_db.query(ProjectChatAgent).count() == before_agents
    assert fixture.parent.metadata_json == before_metadata
    assert fixture.parent.version == before_version
    fixture.push.assert_not_called()


@pytest.mark.parametrize("assignee_id", ["9999999", "nonexistent-agent"])
def test_missing_unconstrained_agent_is_rejected_without_side_effects(
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
    assignee_id: str,
) -> None:
    fixture = collaboration_dispatch
    for agent in (fixture.manager, fixture.worker, fixture.reviewer):
        agent.metadata_json = {**agent.metadata_json, "runtime": "codex"}
    test_db.commit()
    values = _values(fixture, test_user)
    values.items[1].assignee_id = assignee_id
    before_counts = _counts(test_db)
    before_agents = test_db.query(ProjectChatAgent).count()
    before_metadata = deepcopy(fixture.parent.metadata_json)
    before_version = fixture.parent.version

    with pytest.raises(HTTPException) as error:
        loop_item_executions.enqueue_execution_batch(
            fixture.project.id, values, test_db, test_user
        )

    assert error.value.status_code == 404
    assert error.value.detail == "Robot not found"
    assert _counts(test_db) == before_counts
    assert test_db.query(ProjectChatAgent).count() == before_agents
    assert fixture.parent.metadata_json == before_metadata
    assert fixture.parent.version == before_version
    fixture.push.assert_not_called()


@pytest.mark.parametrize("manager_reference", ["canonical", "team_alias"])
def test_matching_human_stage_and_replay_materialize_once(
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
    manager_reference: str,
) -> None:
    fixture = collaboration_dispatch
    _constrain(fixture, test_user)
    values = _values(fixture, test_user)
    if manager_reference == "team_alias":
        for agent in (fixture.manager, fixture.worker, fixture.reviewer):
            agent.metadata_json = {**agent.metadata_json, "runtime": "codex"}
        values.manager_agent_id = str(fixture.manager.metadata_json["wegent_team_id"])
    values.items = values.items[:1]
    test_db.commit()

    first = loop_item_executions.enqueue_execution_batch(
        fixture.project.id, values, test_db, test_user
    )
    after_counts = _counts(test_db)
    after_version = fixture.parent.version
    second = loop_item_executions.enqueue_execution_batch(
        fixture.project.id, values, test_db, test_user
    )

    assert first == second
    assert _counts(test_db) == after_counts
    assert fixture.parent.version == after_version
    assert fixture.parent.assignee_user_id == test_user.id
    assert not fixture.parent.assignee_agent_id
    fixture.push.assert_called_once()


@pytest.mark.parametrize("worker_reference", ["canonical", "team_alias"])
def test_matching_agent_stage_accepts_the_bound_team_alias_and_replays_once(
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
    worker_reference: str,
) -> None:
    fixture = collaboration_dispatch
    team = Kind(
        id=1002,
        kind="Team",
        name="bound-stage-worker",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(team)
    test_db.flush()
    authorize_resource(test_db, fixture.project, team)
    for agent in (fixture.manager, fixture.worker, fixture.reviewer):
        agent.metadata_json = {**agent.metadata_json, "runtime": "codex"}
    fixture.parent.metadata_json = {
        **fixture.parent.metadata_json,
        "workflow": {
            "current_stage_id": "review",
            "nodes": [
                {
                    "id": "review",
                    "name": "Technical review",
                    "required_assignee_type": "agent",
                    "required_assignee_id": fixture.worker.id,
                }
            ],
        },
    }
    values = _values(fixture, test_user)
    values.items = values.items[1:]
    if worker_reference == "team_alias":
        values.items[0].assignee_id = str(team.id)
    test_db.commit()

    first = loop_item_executions.enqueue_execution_batch(
        fixture.project.id, values, test_db, test_user
    )
    after_counts = _counts(test_db)
    after_version = fixture.parent.version
    second = loop_item_executions.enqueue_execution_batch(
        fixture.project.id, values, test_db, test_user
    )

    assert second == first
    assert _counts(test_db) == after_counts
    assert fixture.parent.version == after_version
    assert fixture.parent.assignee_agent_id == fixture.worker.id
    fixture.push.assert_called_once()


@pytest.mark.parametrize(
    "field", ["title", "instructions", "assignee_id", "workflow_stage_id"]
)
def test_round_replay_cannot_replace_its_original_plan(
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
    field: str,
) -> None:
    fixture = collaboration_dispatch
    values = _values(fixture, test_user)
    loop_item_executions.enqueue_execution_batch(
        fixture.project.id, values, test_db, test_user
    )
    before_counts = _counts(test_db)
    before_version = fixture.parent.version
    changed = values.model_copy(deep=True)
    setattr(changed.items[0], field, "different")

    with pytest.raises(HTTPException) as error:
        loop_item_executions.enqueue_execution_batch(
            fixture.project.id, changed, test_db, test_user
        )

    assert error.value.status_code == 409
    assert error.value.detail["reason_code"] == "collaboration_round_mismatch"
    assert _counts(test_db) == before_counts
    assert fixture.parent.version == before_version
    fixture.push.assert_called_once()


def test_duplicate_assignment_ids_are_rejected_before_any_side_effect(
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
) -> None:
    fixture = collaboration_dispatch
    values = _values(fixture, test_user)
    values.items[1].assignment_id = values.items[0].assignment_id
    before_counts = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        loop_item_executions.enqueue_execution_batch(
            fixture.project.id, values, test_db, test_user
        )

    assert error.value.status_code == 422
    assert _counts(test_db) == before_counts
    fixture.push.assert_not_called()


def test_required_human_without_project_access_blocks_the_whole_round(
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
) -> None:
    fixture = collaboration_dispatch
    former_member = User(
        user_name="former-stage-reviewer",
        password_hash="unused",
        email="former-stage-reviewer@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(former_member)
    test_db.flush()
    _constrain(fixture, former_member)
    values = _values(fixture, former_member)
    values.items = values.items[:1]
    test_db.commit()
    before_counts = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        loop_item_executions.enqueue_execution_batch(
            fixture.project.id, values, test_db, test_user
        )

    assert error.value.status_code == 422
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert "project access" in error.value.detail["reason"]
    assert _counts(test_db) == before_counts
    fixture.push.assert_not_called()


@pytest.mark.parametrize("constrained", [False, True])
def test_round_owner_uses_current_stage_only_when_it_has_an_assignee_constraint(
    test_db: Session,
    test_user: User,
    collaboration_dispatch: SimpleNamespace,
    constrained: bool,
) -> None:
    fixture = collaboration_dispatch
    workflow = {
        "nodes": [
            {"id": "approval", "name": "Business approval", "status": "blocked"},
            {"id": "review", "name": "Technical review", "status": "ready"},
        ]
    }
    if constrained:
        team = Kind(
            id=1002,
            kind="Team",
            name="stage-review-worker",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={"spec": {}},
        )
        test_db.add(team)
        test_db.flush()
        authorize_resource(test_db, fixture.project, team)
        workflow["nodes"][1].update(
            required_assignee_type="agent", required_assignee_id=fixture.worker.id
        )
    else:
        workflow["current_stage_id"] = "review"
    fixture.parent.metadata_json = {
        **fixture.parent.metadata_json,
        "workflow": workflow,
    }
    test_db.commit()

    loop_item_executions.enqueue_execution_batch(
        fixture.project.id, _values(fixture, test_user), test_db, test_user
    )

    assert fixture.parent.assignee_user_id == (None if constrained else test_user.id)
    assert fixture.parent.assignee_agent_id == (
        fixture.worker.id if constrained else ""
    )
