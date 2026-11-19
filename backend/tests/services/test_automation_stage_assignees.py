# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Automation preflight must precede even creation of its Issue carrier."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemComment,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.services.automation_stage_assignees import preflight_automation_assignee
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.project_automation_execution import ProjectAutomationExecution
from tests.services.test_external_loop_item_execution import _issue
from tests.services.test_loop_item_assignment import _make_bot
from tests.utils.collaboration import authorize_project


@pytest.fixture
def automation_stage(test_db: Session, test_user: User, monkeypatch) -> SimpleNamespace:
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", Mock())
    project = CloudProject(
        project_key="STAGEAUTO",
        name="Constrained automation",
        created_by_user_id=test_user.id,
        storage_prefix="projects/stage-automation",
        next_item_number=1,
        metadata_json={
            "workflow_definition": {
                "stage_mode": "dag",
                "nodes": [
                    {
                        "id": "implement",
                        "name": "Implementation",
                        "required_assignee_type": "user",
                        "required_assignee_id": str(test_user.id),
                    }
                ],
            }
        },
    )
    authorize_project(test_db, project)
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Stage automation",
        description="Implement the specified stage.",
        created_by_user_id=test_user.id,
        status="enabled",
        metadata_json={"dispatch_target": {"kind": "human", "id": str(test_user.id)}},
    )
    test_db.add(rule)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        title="Stage automation run",
        source="manual",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.commit()
    return SimpleNamespace(
        project=project, rule=rule, run=run, execution=ProjectAutomationExecution()
    )


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


@pytest.mark.asyncio
@pytest.mark.parametrize("snapshot", ["project", "rule"])
async def test_wrong_automation_stage_target_never_creates_a_carrier(
    test_db: Session, test_user: User, monkeypatch, automation_stage, snapshot: str
) -> None:
    s = automation_stage
    if snapshot == "rule":
        definition = s.project.metadata_json["workflow_definition"]
        s.project.metadata_json = {}
        s.rule.metadata_json = {
            **s.rule.metadata_json,
            "event_config": {"runtime_workflow_definition": definition},
        }
    s.rule.metadata_json = {
        **s.rule.metadata_json,
        "dispatch_target": {"kind": "human", "id": "unrelated-target"},
    }
    test_db.commit()
    ensure_carrier = Mock(side_effect=AssertionError("Preflight must reject first"))
    monkeypatch.setattr(s.execution, "_ensure_run_task", ensure_carrier)
    before = _counts(test_db)

    await s.execution.dispatch(test_db, s.rule, s.run)

    test_db.refresh(s.run)
    test_db.refresh(s.project)
    assert s.run.status == "failed"
    assert "stage_assignee_mismatch" in s.run.description
    assert not s.run.task_id
    assert s.project.next_item_number == 1
    assert _counts(test_db) == before
    ensure_carrier.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("constrained", [True, False])
async def test_human_automation_assigns_its_carrier_once(
    test_db: Session, test_user: User, automation_stage, constrained: bool
) -> None:
    s = automation_stage
    if not constrained:
        s.project.metadata_json = {}
        test_db.commit()

    await s.execution.dispatch(test_db, s.rule, s.run)

    test_db.refresh(s.run)
    assert s.run.status == "succeeded"
    item = test_db.get(LoopItem, s.run.task_id)
    assert item is not None
    assert item.assignee_user_id == test_user.id
    assert not item.assignee_agent_id
    if constrained:
        assert item.metadata_json["workflow"]["nodes"][0][
            "required_assignee_id"
        ] == str(test_user.id)
    assignments = (
        test_db.query(LoopItemComment)
        .filter(LoopItemComment.loop_item_id == item.id)
        .all()
    )
    assert (
        len(
            [
                row
                for row in assignments
                if (row.metadata_json or {}).get("action") == "assign"
            ]
        )
        == 1
    )
    assert test_db.query(LoopItemExecution).count() == 0
    before = _counts(test_db)
    version = item.version

    await s.execution.dispatch(test_db, s.rule, s.run)

    assert _counts(test_db) == before
    assert item.version == version


@pytest.mark.asyncio
async def test_existing_issue_uses_its_locked_snapshot_before_dispatch(
    test_db: Session, test_user: User, monkeypatch, automation_stage
) -> None:
    s = automation_stage
    issue = LoopItem(
        id="STAGEAUTO-EXISTING",
        cloud_project_id=str(s.project.id),
        created_by_user_id=test_user.id,
        assignee_user_id=test_user.id,
        title="Existing stage",
        metadata_json={
            "workflow": {
                "current_stage_id": "review",
                "nodes": [
                    {
                        "id": "review",
                        "name": "Technical review",
                        "required_assignee_type": "agent",
                        "required_assignee_id": "required-agent",
                    }
                ],
            }
        },
    )
    test_db.add(issue)
    s.run.task_id = issue.id
    test_db.commit()
    ensure_carrier = Mock(side_effect=AssertionError("Preflight must reject first"))
    monkeypatch.setattr(s.execution, "_ensure_run_task", ensure_carrier)
    before = _counts(test_db)
    version = issue.version

    await s.execution.dispatch(test_db, s.rule, s.run)

    test_db.refresh(s.run)
    test_db.refresh(issue)
    assert s.run.status == "failed"
    assert "stage_assignee_mismatch" in s.run.description
    assert issue.version == version
    assert issue.assignee_user_id == test_user.id
    assert _counts(test_db) == before
    ensure_carrier.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("missing_execution", [False, True])
async def test_matching_agent_automation_creates_one_assigned_execution(
    test_db: Session, test_user: User, monkeypatch, automation_stage, missing_execution
) -> None:
    s = automation_stage
    agent = _make_bot(test_db, s.project, test_user)
    s.project.metadata_json = {
        "workflow_definition": {
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "implement",
                    "name": "Implementation",
                    "required_assignee_type": "agent",
                    "required_assignee_id": agent.id,
                }
            ],
        }
    }
    s.rule.metadata_json = {"dispatch_target": {"kind": "agent", "id": agent.id}}
    test_db.commit()
    before_counts = _counts(test_db)
    before_sequence = s.project.next_item_number
    if missing_execution:
        monkeypatch.setattr(s.execution, "_execution_for_run", lambda *_: None)

    await s.execution.dispatch(test_db, s.rule, s.run)

    test_db.refresh(s.run)
    if missing_execution:
        test_db.refresh(s.project)
        assert s.run.status == "failed"
        assert "automatic-processing Run was not created" in s.run.description
        assert not s.run.task_id
        assert s.project.next_item_number == before_sequence
        assert _counts(test_db) == before_counts
        return
    assert s.run.status == "queued", s.run.description
    item = test_db.get(LoopItem, s.run.task_id)
    assert item is not None
    assert item.assignee_agent_id == agent.id
    assert item.assignee_user_id is None
    executions = test_db.query(LoopItemExecution).all()
    assert len(executions) == 1
    assert executions[0].agent_id == agent.id
    assert s.run.assignee_agent_id == agent.id


@pytest.mark.parametrize("shadow", [True, False])
@pytest.mark.parametrize("matching", [True, False])
def test_existing_external_automation_uses_current_remote_stage(
    test_db, test_user, test_admin_user, monkeypatch, automation_stage, shadow, matching
):
    s = automation_stage
    s.project.metadata_json = {
        **s.project.metadata_json,
        "task_provider": "gitlab",
        "provider_config": {"repository": "group/project"},
        "workflow_definition": {
            "nodes": [
                {
                    "id": "initial",
                    "name": "Initial",
                    "required_assignee_type": "user",
                    "required_assignee_id": str(test_admin_user.id),
                },
                {
                    "id": "review",
                    "name": "Review",
                    "depends_on": ["initial"],
                    "required_assignee_type": "user",
                    "required_assignee_id": str(test_user.id),
                },
            ]
        },
    }
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(s.project.id),
            entity_id=str(test_admin_user.id),
            role="Developer",
            status="approved",
        )
    )
    s.run.task_id = f"{s.project.project_key}-1"
    if shadow:
        test_db.add(
            LoopItem(
                id=s.run.task_id,
                cloud_project_id=str(s.project.id),
                created_by_user_id=test_user.id,
                metadata_json={"external_index": True},
            )
        )
    test_db.commit()
    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        lambda *a: {**_issue(), "labels": ["Review"]},
    )
    target = test_user if matching else test_admin_user
    before = _counts(test_db)

    def preflight():
        return preflight_automation_assignee(
            test_db,
            project=s.project,
            rule=s.rule,
            run=s.run,
            owner=test_user,
            dispatch_target={"kind": "human", "id": str(target.id)},
        )

    if matching:
        result = preflight()
        assert result.assignee_id == str(test_user.id)
    else:
        with pytest.raises(HTTPException) as error:
            preflight()
        assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
        assert error.value.detail["stage_id"] == "review"
    assert _counts(test_db) == before


def test_external_automation_cannot_advance_a_remote_proposal(
    test_db, test_user, test_admin_user, monkeypatch, automation_stage
):
    s = automation_stage
    test_user.user_name = "jiangyang7"
    s.project.metadata_json = {
        "task_provider": "gitlab",
        "provider_config": {"repository": "group/project"},
        "workflow_definition": {
            "feature_flags": {"collab.enforceStageAssignee.v1": True},
            "nodes": [
                {"id": "proposal", "name": "需求提出"},
                {"id": "review", "name": "共同评审", "depends_on": ["proposal"]},
            ],
        },
    }
    s.run.task_id = f"{s.project.project_key}-1"
    test_db.commit()
    remote = {**_issue(), "labels": ["需求提出"]}
    monkeypatch.setattr(external_loop_item_provider, "_get_issue", lambda *a: remote)
    before = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        preflight_automation_assignee(
            test_db,
            project=s.project,
            rule=s.rule,
            run=s.run,
            owner=test_user,
            dispatch_target={"kind": "human", "id": str(test_admin_user.id)},
        )

    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["stage_id"] == "proposal"
    assert remote["labels"] == ["需求提出"]
    assert _counts(test_db) == before
