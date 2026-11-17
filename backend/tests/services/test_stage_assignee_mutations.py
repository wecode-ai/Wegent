# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Stage constraints apply equally to direct mutation and assignment writes."""

from copy import deepcopy

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItemComment
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.wework_notification import WeworkNotification
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.project_chat import LoopItemAssign
from app.services.loop_items.service import loop_item_service
from app.services.stage_assignee_mutations import stage_observer_user_ids
from tests.services.test_stage_assignees import stage_scenario  # noqa: F401


@pytest.fixture(autouse=True)
def isolate_delivery(monkeypatch):
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *_args: None)


def _counts(db):
    return tuple(
        db.query(model).count()
        for model in (
            LoopItemComment,
            LoopItemExecution,
            WeworkNotification,
        )
    )


@pytest.mark.parametrize("entrypoint", ["assign", "patch"])
def test_wrong_owner_is_rejected_before_persistence(stage_scenario, entrypoint):
    s = stage_scenario
    s.db.commit()
    before = _counts(s.db)
    version = s.issue.version
    with pytest.raises(HTTPException) as error:
        if entrypoint == "assign":
            loop_item_service.assign(
                s.db,
                project_id=int(s.project.id),
                item_id=s.issue.id,
                user_id=s.owner.id,
                values=LoopItemAssign(
                    version=version, assignee_type="user", assignee_id="9999999"
                ),
            )
        else:
            loop_item_service.update(
                s.db,
                s.issue.id,
                s.owner.id,
                LoopItemUpdate(version=version, assignee_user_id=9999999),
            )
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert _counts(s.db) == before
    s.db.refresh(s.issue)
    assert s.issue.version == version
    assert s.issue.assignee_user_id == s.owner.id


@pytest.mark.parametrize("entrypoint", ["assign", "patch"])
def test_introduction_reassignment_commits_review_with_owner(
    stage_scenario,
    test_admin_user,
    entrypoint,
):
    s = stage_scenario
    s.owner.user_name = "jiangyang7"
    s.db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(s.project.id),
            entity_id=str(test_admin_user.id),
            role="Developer",
            status="approved",
        )
    )
    s.issue.metadata_json = {
        "tags": ["需求提出", "other"],
        "workflow": {
            "current_stage_id": "proposal",
            "nodes": [
                {"id": "proposal", "name": "需求提出"},
                {"id": "review", "name": "共同评审"},
            ],
        },
    }
    s.db.commit()
    version = s.issue.version
    if entrypoint == "assign":
        saved = loop_item_service.assign(
            s.db,
            project_id=int(s.project.id),
            item_id=s.issue.id,
            user_id=s.owner.id,
            values=LoopItemAssign(
                version=version,
                assignee_type="user",
                assignee_id=str(test_admin_user.id),
            ),
        )
    else:
        saved = loop_item_service.update(
            s.db,
            s.issue.id,
            s.owner.id,
            LoopItemUpdate(version=version, assignee_user_id=test_admin_user.id),
        )
    assert saved.assignee_user_id == test_admin_user.id
    assert saved.metadata_json["workflow"]["current_stage_id"] == "review"
    assert saved.metadata_json["tags"] == ["other", "共同评审"]
    assert saved.version == version + 1
    assert len(saved.metadata_json["stage_assignee_history"]) == 1
    assert (
        s.db.query(LoopItemComment)
        .filter(
            LoopItemComment.metadata_json["event_type"].as_string()
            == "stage_assignee_transition"
        )
        .count()
        == 1
    )
    assert (
        s.db.query(WeworkNotification)
        .filter(WeworkNotification.title == "Issue stage advanced")
        .count()
        == 1
    )


def test_stale_assignment_cannot_create_an_assignment(stage_scenario):
    s = stage_scenario
    s.db.commit()
    before = _counts(s.db)
    with pytest.raises(HTTPException) as error:
        loop_item_service.assign(
            s.db,
            project_id=int(s.project.id),
            item_id=s.issue.id,
            user_id=s.owner.id,
            values=LoopItemAssign(
                version=s.issue.version + 1,
                assignee_type="user",
                assignee_id=str(s.owner.id),
            ),
        )
    assert error.value.status_code == 409
    assert _counts(s.db) == before


def test_initial_workflow_cannot_bypass_an_unselected_stage(stage_scenario):
    s = stage_scenario
    workflow = deepcopy(s.issue.metadata_json["workflow"])
    workflow.pop("current_stage_id")
    workflow["nodes"][0]["required_assignee_id"] = "9999999"
    with pytest.raises(HTTPException) as error:
        loop_item_service.create(
            s.db,
            int(s.project.id),
            s.owner.id,
            LoopItemCreate(title="Wrong owner", workflow=workflow),
        )
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"


def test_robot_assignment_keeps_review_in_pending(stage_scenario):
    s = stage_scenario
    s.issue.status = "pending"
    metadata = {"tags": ["共同评审"]}
    updates = {}
    loop_item_service._start_robot_assignment(
        project=s.project,
        item=s.issue,
        user_id=s.owner.id,
        metadata=metadata,
        updates=updates,
    )
    assert updates.get("status", s.issue.status) == "pending"
    assert "status_history" not in metadata


def test_developer_cannot_remove_constraints_in_a_stage_update(
    stage_scenario,
    test_admin_user,
):
    s = stage_scenario
    s.db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(s.project.id),
            entity_id=str(test_admin_user.id),
            role="Developer",
            status="approved",
        )
    )
    s.db.commit()
    before = deepcopy(s.issue.metadata_json)
    workflow = deepcopy(before["workflow"])
    workflow["nodes"][0].pop("required_assignee_type")
    workflow["nodes"][0].pop("required_assignee_id")
    with pytest.raises(HTTPException) as error:
        loop_item_service.update(
            s.db,
            s.issue.id,
            test_admin_user.id,
            LoopItemUpdate(version=s.issue.version, workflow=workflow),
        )
    assert error.value.status_code == 403
    s.db.refresh(s.issue)
    assert s.issue.metadata_json == before


def test_manual_workflow_patch_cannot_enter_quality_without_observations(
    stage_scenario,
):
    s = stage_scenario
    s.db.commit()
    original = deepcopy(s.issue.metadata_json)
    before = _counts(s.db)
    workflow = deepcopy(original["workflow"])
    workflow["nodes"].append({"id": "quality", "name": "质量验收"})
    workflow["current_stage_id"] = "quality"

    with pytest.raises(HTTPException) as error:
        loop_item_service.update(
            s.db,
            s.issue.id,
            s.owner.id,
            LoopItemUpdate(
                version=s.issue.version, workflow=workflow, tags=["质量验收"]
            ),
        )

    assert error.value.status_code == 409
    assert error.value.detail["reason_code"] == "quality_pr_snapshot_required"
    assert _counts(s.db) == before
    s.db.refresh(s.issue)
    assert s.issue.metadata_json == original


def test_patch_does_not_accept_raw_quality_metadata(stage_scenario):
    s = stage_scenario
    s.db.commit()
    values = LoopItemUpdate.model_validate(
        {
            "version": s.issue.version,
            "title": "Edited title",
            "quality_handoff": {
                "required_assignee_role": "qa",
                "pr_heads": {"fake": {"complete": True}},
            },
            "metadata_json": {"quality_handoff": {"required_assignee_role": "qa"}},
        }
    )

    saved = loop_item_service.update(s.db, s.issue.id, s.owner.id, values)

    assert values.model_fields_set == {"version", "title"}
    assert saved.title == "Edited title"
    assert "quality_handoff" not in saved.metadata_json


@pytest.mark.parametrize("stage", ["开发实现", "质量验收"])
def test_engineering_issue_owner_can_update_after_a_failed_pr_handoff(
    stage_scenario, stage
):
    s = stage_scenario
    metadata = deepcopy(s.issue.metadata_json)
    metadata.update(
        {
            "owner": {"eng": s.owner.user_name},
            "quality_handoff": {
                "required_assignee_role": "engineering",
                "quality_blocked": True,
            },
        }
    )
    metadata["workflow"]["nodes"][0]["name"] = stage
    metadata["tags"] = [stage]
    if stage == "质量验收":
        s.issue.status = "in_review"
    s.issue.metadata_json = metadata
    s.db.commit()

    saved = loop_item_service.update(
        s.db,
        s.issue.id,
        s.owner.id,
        LoopItemUpdate(version=s.issue.version, title="Fixing required checks"),
    )

    assert saved.title == "Fixing required checks"
    assert saved.assignee_user_id == s.owner.id
    assert (
        saved.metadata_json["quality_handoff"]["required_assignee_role"]
        == "engineering"
    )


def test_stage_observers_use_the_pilot_pmo_before_maintainers(
    stage_scenario, test_admin_user
):
    s = stage_scenario
    test_admin_user.user_name = "zhongwei9"
    s.db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(s.project.id),
            entity_id=str(test_admin_user.id),
            role="Developer",
            status="approved",
        )
    )
    s.db.flush()

    recipients = stage_observer_user_ids(
        s.db,
        project=s.project,
        item=s.issue,
        metadata=s.issue.metadata_json,
    )

    assert recipients == {test_admin_user.id}


def test_stage_observers_do_not_expose_restricted_issues_to_pmo(
    stage_scenario, test_admin_user
):
    s = stage_scenario
    s.db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(s.project.id),
            entity_id=str(test_admin_user.id),
            role="Developer",
            status="approved",
        )
    )
    metadata = deepcopy(s.issue.metadata_json)
    metadata["security_level"] = "related"
    metadata["workflow"]["assignee_roles"] = {
        "pmo": [{"assignee_type": "user", "assignee_id": str(test_admin_user.id)}],
    }
    s.db.flush()

    assert (
        stage_observer_user_ids(
            s.db,
            project=s.project,
            item=s.issue,
            metadata=metadata,
        )
        == set()
    )
