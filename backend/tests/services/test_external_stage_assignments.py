# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""External assignment mutations validate fresh phases before side effects."""

from copy import deepcopy
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem, LoopItemComment
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.wework_notification import WeworkNotification
from app.schemas.project_chat import LoopItemAssign
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items import external_provider as external_provider_module
from app.services.loop_items.external_provider import external_loop_item_provider
from tests.services.test_external_loop_item_execution import (
    _issue,
    _item_id,
    _make_gitlab_project,
)


def _scenario(db, owner, other, monkeypatch, *, shadow=False):
    project = _make_gitlab_project(db, owner)
    workflow = {
        "nodes": [
            {
                "id": "build",
                "name": "开发实现",
                "required_assignee_type": "user",
                "required_assignee_id": str(owner.id),
            },
            {"id": "other", "name": "共同评审"},
        ]
    }
    project.metadata_json = {**project.metadata_json, "workflow_definition": workflow}
    db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_id=str(other.id),
            role="Developer",
            status="approved",
        )
    )
    if shadow:
        db.add(
            LoopItem(
                id=_item_id(project),
                cloud_project_id=str(project.id),
                title="Stale external index",
                created_by_user_id=owner.id,
                assignee_user_id=owner.id,
                metadata_json={
                    "tags": [],
                    "workflow": {**deepcopy(workflow), "current_stage_id": "other"},
                },
            )
        )
    db.commit()
    remote = {**_issue(), "labels": ["开发实现"]}
    monkeypatch.setattr(external_loop_item_provider, "_get_issue", lambda *a: remote)
    write = Mock(side_effect=AssertionError("Unexpected remote write"))
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", write)
    monkeypatch.setattr(external_loop_item_provider, "_create_comment", write)
    return project, write


def _counts(db):
    return tuple(
        db.query(model).count()
        for model in (LoopItem, LoopItemComment, LoopItemExecution, WeworkNotification)
    )


@pytest.mark.parametrize("shadow", [False, True])
@pytest.mark.parametrize("step", [None, "other", "missing"])
def test_provider_assignment_checks_remote_root_and_requested_scope_before_writes(
    test_db, test_user, test_admin_user, monkeypatch, shadow, step
):
    project, write = _scenario(
        test_db, test_user, test_admin_user, monkeypatch, shadow=shadow
    )
    before = _counts(test_db)
    with pytest.raises(HTTPException) as error:
        external_loop_item_provider.assign(
            test_db,
            _item_id(project),
            test_user.id,
            LoopItemAssign(
                version=1,
                assignee_type="user",
                assignee_id=str(test_admin_user.id),
                workflow_step=step,
            ),
        )
    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert _counts(test_db) == before
    write.assert_not_called()


def test_empty_remote_stage_does_not_reuse_stale_unconstrained_pointer(
    test_db, test_user, test_admin_user, monkeypatch
):
    project, write = _scenario(
        test_db, test_user, test_admin_user, monkeypatch, shadow=True
    )
    monkeypatch.setattr(external_loop_item_provider, "_get_issue", lambda *a: _issue())
    before = _counts(test_db)

    with pytest.raises(HTTPException) as error:
        external_loop_item_provider.assign(
            test_db,
            _item_id(project),
            test_user.id,
            LoopItemAssign(
                version=external_loop_item_provider._derived_version(
                    _issue()["updated_at"]
                ),
                assignee_type="user",
                assignee_id=str(test_admin_user.id),
            ),
        )

    assert error.value.detail["reason_code"] == "stage_assignee_mismatch"
    assert error.value.detail["reason"] == "Workflow stage selection is required"
    assert _counts(test_db) == before
    write.assert_not_called()


@pytest.mark.parametrize("context_only", [True, False])
def test_remote_phase_is_read_after_the_shared_issue_lock(
    test_db, test_user, test_admin_user, monkeypatch, context_only
):
    project, write = _scenario(
        test_db, test_user, test_admin_user, monkeypatch, shadow=True
    )
    locked = False
    original = external_provider_module.lock_external_assignment_item

    def acquire(*args, **kwargs):
        nonlocal locked
        result = original(*args, **kwargs)
        locked = True
        return result

    def fresh_remote(*args):
        assert locked, "The remote observation must follow the Issue lock"
        return {
            **_issue(),
            "labels": ["开发实现"],
            "updated_at": "2026-08-07T00:01:00Z",
        }

    monkeypatch.setattr(
        external_provider_module, "lock_external_assignment_item", acquire
    )
    monkeypatch.setattr(external_loop_item_provider, "_get_issue", fresh_remote)
    before = _counts(test_db)

    if context_only:
        _, item = external_loop_item_provider.assignment_stage_context(
            test_db, _item_id(project), test_user.id
        )
        assert item.metadata_json["workflow"]["current_stage_id"] == "build"
    else:
        with pytest.raises(HTTPException) as error:
            external_loop_item_provider.assign(
                test_db,
                _item_id(project),
                test_user.id,
                LoopItemAssign(
                    version=external_loop_item_provider._derived_version(
                        _issue()["updated_at"]
                    ),
                    assignee_type="user",
                    assignee_id=str(test_user.id),
                ),
            )
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "version_conflict"
    assert _counts(test_db) == before
    write.assert_not_called()


def test_external_assignment_comment_is_rejected_before_shadow_or_comment(
    test_db, test_user, test_admin_user, test_client, test_token, monkeypatch
):
    project, write = _scenario(test_db, test_user, test_admin_user, monkeypatch)
    before = _counts(test_db)

    response = test_client.post(
        f"/api/v1/loop-items/{_item_id(project)}/assignments",
        headers={"Authorization": f"Bearer {test_token}"},
        json={
            "target_type": "human",
            "target_id": str(test_admin_user.id),
            "comment_body": "Please implement",
            "workflow_step": "other",
        },
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["reason_code"] == "stage_assignee_mismatch"
    assert _counts(test_db) == before
    write.assert_not_called()


def test_external_delete_checks_fresh_tags_instead_of_stale_shadow(
    test_db, test_user, test_admin_user, test_client, test_token, monkeypatch
):
    project, write = _scenario(
        test_db, test_user, test_admin_user, monkeypatch, shadow=True
    )
    assignment, _ = issue_assignment_service.record(
        test_db,
        project_id=int(project.id),
        issue_id=_item_id(project),
        member_type="human",
        member_id=str(test_user.id),
        assigned_by_user_id=test_user.id,
        workflow_step=None,
        notify=False,
        trigger="test",
    )
    test_db.commit()
    before = _counts(test_db)
    original = deepcopy(test_db.get(LoopItem, _item_id(project)).metadata_json)

    response = test_client.delete(
        f"/api/v1/loop-items/{_item_id(project)}/assignments/{assignment.id}",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["reason_code"] == "stage_assignee_mismatch"
    assert _counts(test_db) == before
    assert test_db.get(LoopItem, _item_id(project)).metadata_json == original
    assert issue_assignment_service.active_for_issue(test_db, _item_id(project))
    write.assert_not_called()
