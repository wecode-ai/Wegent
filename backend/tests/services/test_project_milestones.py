"""Milestone references must stay inside their owning project."""

from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, LoopItem, ProjectMilestone
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.services.cloud_projects.access import IssueAction, issue_update_actions
from app.services.project_milestones import require_milestone


def test_milestone_reference_checks_project_and_deletion(test_db):
    test_db.add_all(
        [
            CloudProject(id="101", name="A", project_key="MA"),
            CloudProject(id="102", name="B", project_key="MB"),
        ]
    )
    test_db.flush()
    milestone = ProjectMilestone(
        id="ms-one", cloud_project_id="101", title="v1", status="open"
    )
    test_db.add(milestone)
    test_db.flush()
    require_milestone(test_db, "101", milestone.id)
    require_milestone(test_db, "102", None)
    with pytest.raises(HTTPException) as wrong_project:
        require_milestone(test_db, "102", milestone.id)
    assert wrong_project.value.status_code == 422
    milestone.deleted_at = datetime(2026, 11, 4)
    test_db.flush()
    with pytest.raises(HTTPException) as deleted:
        require_milestone(test_db, "101", milestone.id)
    assert deleted.value.status_code == 422


def test_milestone_assignment_is_content_edit_even_when_mixed_with_assignment():
    assert issue_update_actions({"milestone_id"}) == [IssueAction.EDIT_CONTENT]
    assert set(issue_update_actions({"milestone_id", "assignee_user_id"})) == {
        IssueAction.EDIT_CONTENT,
        IssueAction.ASSIGN,
    }


def test_milestone_inputs_preserve_explicit_clear_and_do_not_inherit_parent():
    created = LoopItemCreate(title="Child", parent_id="PARENT-1")
    assert created.milestone_id is None
    absent = LoopItemUpdate(version=1)
    cleared = LoopItemUpdate(version=1, milestone_id=None)
    assert "milestone_id" not in absent.model_fields_set
    assert cleared.model_dump(exclude_unset=True)["milestone_id"] is None
    issue = LoopItem(metadata_json={"milestone_id": "ms-one"})
    assert issue.milestone_id == "ms-one"


def test_issue_api_creates_and_clears_milestone_without_losing_other_fields(
    test_client, test_token, test_db
):
    headers = {"Authorization": f"Bearer {test_token}"}
    space = test_client.post(
        "/api/v1/workspaces", headers=headers, json={"name": "Milestone API"}
    )
    assert space.status_code == 201, space.text
    project = test_client.post(
        f"/api/v1/workspaces/{space.json()['id']}/projects",
        headers=headers,
        json={"name": "Milestone project"},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["id"]
    test_db.add(
        ProjectMilestone(
            id="ms-api", cloud_project_id=project_id, title="v1", status="open"
        )
    )
    test_db.commit()
    created = test_client.post(
        f"/api/v1/cloud-projects/{project_id}/loop-items",
        headers=headers,
        json={"title": "Ship", "milestone_id": "ms-api", "tags": ["release"]},
    )
    assert created.status_code == 201, created.text
    issue = created.json()
    assert issue["milestone_id"] == "ms-api"
    unchanged = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=headers,
        json={"version": issue["version"], "milestone_id": "ms-api"},
    )
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json()["content_revision"] == issue["content_revision"]
    cleared = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=headers,
        json={"version": unchanged.json()["version"], "milestone_id": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["milestone_id"] is None
    assert cleared.json()["tags"] == ["release"]
    assert cleared.json()["title"] == "Ship"
    assert cleared.json()["content_revision"] == issue["content_revision"] + 1
    already_cleared = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=headers,
        json={"version": cleared.json()["version"], "milestone_id": None},
    )
    assert already_cleared.status_code == 200, already_cleared.text
    assert (
        already_cleared.json()["content_revision"] == cleared.json()["content_revision"]
    )
