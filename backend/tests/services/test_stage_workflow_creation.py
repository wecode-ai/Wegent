# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Explicit creation workflows cannot silently replace project stage policy."""

from copy import deepcopy

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem, LoopItemActiveAssignment, LoopItemComment
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.wework_notification import WeworkNotification
from app.schemas.delivery import LoopItemCreate
from app.services.loop_items.service import loop_item_service
from tests.services.test_stage_assignees import stage_scenario  # noqa: F401


def _developer(s, user):
    s.db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(s.project.id),
            entity_id=str(user.id),
            role="Developer",
            status="approved",
        )
    )


def _counts(db):
    return tuple(
        db.query(model).count()
        for model in (
            LoopItem,
            LoopItemComment,
            LoopItemActiveAssignment,
            LoopItemExecution,
            WeworkNotification,
        )
    )


@pytest.mark.parametrize("override", ["disable", "remove", "rename"])
def test_developer_cannot_override_project_constraints_during_creation(
    stage_scenario, test_admin_user, override
):
    s = stage_scenario
    _developer(s, test_admin_user)
    definition = deepcopy(s.issue.metadata_json["workflow"])
    s.project.metadata_json = {"workflow_definition": definition}
    workflow = deepcopy(definition)
    if override == "disable":
        workflow["feature_flags"] = {"collab.enforceStageAssignee.v1": False}
    elif override == "remove":
        workflow["nodes"][0].pop("required_assignee_type")
        workflow["nodes"][0].pop("required_assignee_id")
    else:
        workflow["nodes"] = [{"id": "build", "name": "Unconstrained work"}]
    s.db.commit()
    before = _counts(s.db)
    sequence = s.project.next_item_number

    with pytest.raises(HTTPException) as error:
        loop_item_service.create(
            s.db,
            int(s.project.id),
            test_admin_user.id,
            LoopItemCreate(
                title="Override project policy",
                assignee_user_id=test_admin_user.id,
                workflow=workflow,
            ),
        )

    assert error.value.status_code == 403
    s.db.flush()
    s.db.refresh(s.project)
    assert _counts(s.db) == before
    assert s.project.next_item_number == sequence
    assert s.project.metadata_json == {"workflow_definition": definition}


def test_developer_can_create_with_the_same_project_constraints(
    stage_scenario, test_admin_user, monkeypatch
):
    s = stage_scenario
    _developer(s, test_admin_user)
    workflow = deepcopy(s.issue.metadata_json["workflow"])
    s.project.metadata_json = {"workflow_definition": workflow}
    s.project.next_item_number = 2
    s.db.commit()
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *_args: None)

    created = loop_item_service.create(
        s.db,
        int(s.project.id),
        test_admin_user.id,
        LoopItemCreate(
            title="Use project policy",
            assignee_user_id=s.owner.id,
            workflow=workflow,
        ),
    )

    assert created.assignee_user_id == s.owner.id
    assert created.metadata_json["workflow"]["nodes"][0]["required_assignee_id"] == str(
        s.owner.id
    )


@pytest.mark.parametrize("stage_name", ["Standard work", "需求提出", "质量验收"])
def test_unconstrained_project_preserves_custom_creation_workflow(
    stage_scenario, test_admin_user, monkeypatch, stage_name
):
    s = stage_scenario
    _developer(s, test_admin_user)
    s.project.metadata_json = {
        "workflow_definition": {"nodes": [{"id": "standard", "name": stage_name}]}
    }
    s.project.next_item_number = 2
    s.db.commit()
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *_args: None)

    created = loop_item_service.create(
        s.db,
        int(s.project.id),
        test_admin_user.id,
        LoopItemCreate(
            title="Custom workflow",
            workflow={
                "current_stage_id": "custom",
                "nodes": [{"id": "custom", "name": "Custom work"}],
            },
        ),
    )

    assert created.assignee_user_id == test_admin_user.id
    assert created.metadata_json["workflow"]["current_stage_id"] == "custom"
