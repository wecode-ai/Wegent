# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""External creation enforces stage targets before remote or execution writes."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem, LoopItemComment
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.wework_notification import WeworkNotification
from app.schemas.delivery import LoopItemCreate
from app.schemas.issue_workflow import ProjectWorkflowDefinition, instantiate_workflow
from app.schemas.project_chat import LoopItemAssign
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.stage_assignees import STAGE_ASSIGNEE_FLAG
from tests.services.test_external_loop_item_execution import (
    _issue,
    _make_bot,
    _make_gitlab_project,
)


@pytest.fixture
def creation_scenario(test_db, test_user, test_admin_user, monkeypatch):
    project = _make_gitlab_project(test_db, test_user)
    project.metadata_json = {
        **project.metadata_json,
        "workflow_definition": {
            "stage_mode": "dag",
            "nodes": [
                {"id": "other", "name": "Other"},
                {
                    "id": "build",
                    "name": "Build",
                    "depends_on": ["other"],
                    "required_assignee_type": "user",
                    "required_assignee_id": str(test_user.id),
                },
            ],
        },
    }
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_id=str(test_admin_user.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.commit()

    def create_issue(_project, title, body, labels):
        return {**_issue(), "title": title, "description": body, "labels": labels}

    remote_create = Mock(side_effect=create_issue)
    monkeypatch.setattr(external_loop_item_provider, "_create_issue", remote_create)
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", Mock())
    return SimpleNamespace(project=project, remote_create=remote_create)


def _counts(db):
    return tuple(
        db.query(model).count()
        for model in (LoopItem, LoopItemComment, LoopItemExecution, WeworkNotification)
    )


def _create(db, user, scenario, **fields):
    return external_loop_item_provider.create(
        db,
        scenario.project.id,
        user.id,
        user.user_name,
        LoopItemCreate(title="External stage task", tags=["Build"], **fields),
    )


@pytest.mark.parametrize("flag", [None, True])
@pytest.mark.parametrize("explicit_workflow", [False, True])
def test_external_create_rejects_wrong_human_before_any_write(
    test_db, test_user, test_admin_user, creation_scenario, flag, explicit_workflow
):
    s = creation_scenario
    if flag is not None:
        s.project.metadata_json = {
            **s.project.metadata_json,
            "workflow_definition": {
                **s.project.metadata_json["workflow_definition"],
                "feature_flags": {STAGE_ASSIGNEE_FLAG: flag},
            },
        }
        test_db.commit()
    fields = {"assignee_user_id": test_admin_user.id}
    if explicit_workflow:
        fields["workflow"] = instantiate_workflow(
            ProjectWorkflowDefinition.model_validate(
                {"stage_mode": "dag", "nodes": [{"id": "decoy", "name": "Decoy"}]}
            )
        )
    before = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        _create(test_db, test_user, s, **fields)

    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["stage_id"] == "build"
    assert error.value.detail["actual_assignee"]["assignee_id"] == str(
        test_admin_user.id
    )
    s.remote_create.assert_not_called()
    assert _counts(test_db) == before


def test_external_create_rejects_wrong_agent_before_remote_issue_or_execution(
    test_db, test_user, creation_scenario
):
    s = creation_scenario
    agent = _make_bot(test_db, s.project, test_user)
    before = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        _create(test_db, test_user, s, assignee_agent_id=agent.id)

    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["actual_assignee"] == {
        "assignee_type": "agent",
        "assignee_id": agent.id,
    }
    s.remote_create.assert_not_called()
    assert _counts(test_db) == before


def test_external_create_cannot_leave_a_required_stage_unassigned(
    test_db, test_user, creation_scenario
):
    s = creation_scenario
    before = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        _create(test_db, test_user, s)

    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["actual_assignee"]["assignee_id"] is None
    s.remote_create.assert_not_called()
    assert _counts(test_db) == before


@pytest.mark.parametrize("rollback", [False, True])
def test_external_create_keeps_matching_target_and_explicit_rollback_behavior(
    test_db, test_user, test_admin_user, creation_scenario, rollback
):
    s = creation_scenario
    if rollback:
        s.project.metadata_json = {
            **s.project.metadata_json,
            "workflow_definition": {
                **s.project.metadata_json["workflow_definition"],
                "feature_flags": {STAGE_ASSIGNEE_FLAG: False},
            },
        }
        test_db.commit()
    target_id = test_admin_user.id if rollback else test_user.id

    result = _create(test_db, test_user, s, assignee_user_id=target_id)

    assert result["assignee_user_id"] == target_id
    assert result["tags"] == ["Build"]
    s.remote_create.assert_called_once()
    assert test_db.query(LoopItemExecution).count() == 0


@pytest.mark.parametrize("flag", [None, False, True])
def test_external_pilot_creation_requires_explicit_enrollment_and_cannot_advance(
    test_db, test_user, test_admin_user, creation_scenario, flag
):
    s = creation_scenario
    test_user.user_name = "jiangyang7"
    workflow = {
        "nodes": [
            {"id": "proposal", "name": "需求提出"},
            {"id": "review", "name": "共同评审", "depends_on": ["proposal"]},
        ]
    }
    if flag is not None:
        workflow["feature_flags"] = {STAGE_ASSIGNEE_FLAG: flag}
    s.project.metadata_json = {
        **s.project.metadata_json,
        "workflow_definition": workflow,
    }
    test_db.commit()
    values = LoopItemCreate(
        title="External proposal",
        tags=["需求提出"],
        assignee_user_id=test_admin_user.id,
    )
    before = _counts(test_db)

    if flag is True:
        with pytest.raises(HTTPException) as error:
            external_loop_item_provider.create(
                test_db, s.project.id, test_user.id, test_user.user_name, values
            )
        assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
        assert error.value.detail["stage_id"] == "proposal"
        s.remote_create.assert_not_called()
        assert _counts(test_db) == before
    else:
        result = external_loop_item_provider.create(
            test_db, s.project.id, test_user.id, test_user.user_name, values
        )
        assert result["assignee_user_id"] == test_admin_user.id
        assert result["tags"] == ["需求提出"]
        s.remote_create.assert_called_once()


def test_external_create_api_rejects_stage_mismatch_before_remote_write(
    test_db, test_admin_user, creation_scenario, test_client, test_token
):
    before = _counts(test_db)
    response = test_client.post(
        f"/api/v1/cloud-projects/{creation_scenario.project.id}/loop-items",
        headers={"Authorization": f"Bearer {test_token}"},
        json={
            "title": "External constrained stage",
            "tags": ["Build"],
            "assignee_user_id": test_admin_user.id,
        },
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["reason_code"] == "stage_assignee_mismatch"
    creation_scenario.remote_create.assert_not_called()
    assert _counts(test_db) == before


def test_external_create_persists_the_policy_that_authorized_creation(
    test_db, test_user, test_admin_user, creation_scenario, monkeypatch
):
    s = creation_scenario
    definition = deepcopy(s.project.metadata_json["workflow_definition"])
    definition["feature_flags"] = {STAGE_ASSIGNEE_FLAG: True}
    definition["assignee_roles"] = {
        "engineering": [{"assignee_type": "user", "assignee_id": str(test_user.id)}]
    }
    s.project.metadata_json = {
        **s.project.metadata_json,
        "workflow_definition": definition,
    }
    test_db.commit()
    remote = {}

    def create_issue(_project, title, body, labels):
        remote.update(
            {**_issue(), "title": title, "description": body, "labels": labels}
        )
        live = deepcopy(definition)
        live["nodes"][1]["required_assignee_id"] = str(test_admin_user.id)
        s.project.metadata_json = {
            **s.project.metadata_json,
            "workflow_definition": live,
        }
        return dict(remote)

    def update_issue(_project, _number, payload):
        remote["labels"] = list(payload["labels"])
        remote["updated_at"] = "2026-08-07T00:01:00Z"
        return dict(remote)

    s.remote_create.side_effect = create_issue
    monkeypatch.setattr(
        external_loop_item_provider, "_get_issue", lambda *_: dict(remote)
    )
    remote_update = Mock(side_effect=update_issue)
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", remote_update)

    result = _create(test_db, test_user, s, assignee_user_id=test_user.id)

    row = test_db.get(LoopItem, result["id"])
    snapshot = {**definition, "current_stage_id": "build"}
    assert row is not None
    assert row.metadata_json["workflow"] == snapshot
    test_db.expire_all()
    with pytest.raises(HTTPException) as error:
        external_loop_item_provider.assign(
            test_db,
            result["id"],
            test_user.id,
            LoopItemAssign(
                version=result["version"],
                assignee_type="user",
                assignee_id=str(test_admin_user.id),
                notify_assignee=False,
            ),
        )
    assert error.value.detail["expected_assignee"]["assignee_id"] == str(test_user.id)
    remote_update.assert_not_called()
    external_loop_item_provider.assign(
        test_db,
        result["id"],
        test_user.id,
        LoopItemAssign(
            version=result["version"],
            assignee_type="user",
            assignee_id=str(test_user.id),
            notify_assignee=False,
        ),
    )
    assert row.metadata_json["workflow"] == snapshot


def test_remote_creation_failure_does_not_persist_a_policy_or_execution(
    test_db, test_user, creation_scenario
):
    s = creation_scenario
    s.remote_create.side_effect = HTTPException(502, "Provider unavailable")
    before = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        _create(test_db, test_user, s, assignee_user_id=test_user.id)

    assert error.value.status_code == 502
    assert _counts(test_db) == before


def test_repeated_external_create_keeps_the_first_policy_snapshot(
    test_db, test_user, test_admin_user, creation_scenario
):
    s = creation_scenario
    first = _create(test_db, test_user, s, assignee_user_id=test_user.id)
    row = test_db.get(LoopItem, first["id"])
    original = deepcopy(row.metadata_json["workflow"])
    definition = deepcopy(s.project.metadata_json["workflow_definition"])
    definition["nodes"][1]["required_assignee_id"] = str(test_admin_user.id)
    s.project.metadata_json = {
        **s.project.metadata_json,
        "workflow_definition": definition,
    }
    test_db.commit()

    repeated = _create(test_db, test_user, s, assignee_user_id=test_admin_user.id)

    assert repeated["id"] == first["id"]
    test_db.refresh(row)
    assert row.metadata_json["workflow"] == original
    assert test_db.query(LoopItem).filter_by(id=first["id"]).count() == 1
    assert test_db.query(LoopItemExecution).count() == 0
