"""Task-token authentication for Plugin Creator workspace publication."""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from pytest_mock import MockerFixture
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import PluginRelease, PluginSubmission
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.installed_plugin import (
    PluginSubmissionInitResponse,
)
from app.services.auth.task_token import create_task_token


@pytest.fixture
def active_task_auth(
    test_db: Session,
    test_user: User,
) -> tuple[str, TaskResource, Subtask]:
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="plugin-submission-task",
        namespace="default",
        json={"status": {"status": "RUNNING"}},
        is_active=TaskResource.STATE_ACTIVE,
    )
    test_db.add(task)
    test_db.flush()
    subtask = Subtask(
        user_id=test_user.id,
        task_id=task.id,
        team_id=1,
        title="Publish workspace plugin",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
    )
    test_db.add(subtask)
    test_db.commit()
    token = create_task_token(
        task_id=task.id,
        subtask_id=subtask.id,
        user_id=test_user.id,
        user_name=test_user.user_name,
    )
    return token, task, subtask


def _init_request() -> dict[str, object]:
    return {
        "slug": "workspace-plugin",
        "displayName": "Workspace Plugin",
        "version": "0.1.0",
        "filename": "workspace-plugin.zip",
        "sha256": "a" * 64,
        "sizeBytes": 128,
        "listingType": "plugin",
        "visibility": "personal",
        "targets": [],
        "allowCopy": False,
    }


def _submission(
    test_db: Session,
    test_user: User,
    *,
    task_id: int,
    subtask_id: int,
) -> PluginSubmission:
    release = PluginRelease(
        plugin_id=41,
        version="0.1.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/staging/test.zip",
        sha256="a" * 64,
        size_bytes=128,
        status="ready",
        scan_status="passed",
        scan_report_json={"taskBinding": {"taskId": task_id, "subtaskId": subtask_id}},
        created_by_user_id=test_user.id,
    )
    test_db.add(release)
    test_db.flush()
    submission = PluginSubmission(
        plugin_id=41,
        release_id=release.id,
        submitter_user_id=test_user.id,
        purpose="restricted_share",
        status="approved",
    )
    test_db.add(submission)
    test_db.commit()
    return submission


def test_task_token_can_initialize_personal_plugin_submission(
    test_client: TestClient,
    active_task_auth: tuple[str, TaskResource, Subtask],
    mocker: MockerFixture,
) -> None:
    token, task, subtask = active_task_auth
    init_submission = mocker.patch(
        "app.api.endpoints.installed_plugins.plugin_marketplace_service.init_submission",
        return_value=PluginSubmissionInitResponse(
            submissionId=31,
            pluginId=41,
            releaseId=51,
            uploadUrl="http://storage.invalid/upload",
            expiresAt=datetime(2026, 8, 25, 12, 0, 0),
        ),
    )

    response = test_client.post(
        "/api/plugins/submissions/init",
        headers={"Authorization": f"Bearer {token}"},
        json=_init_request(),
    )

    assert response.status_code == 201
    assert response.json()["submissionId"] == 31
    init_submission.assert_called_once()
    assert init_submission.call_args.kwargs["task_binding"] == (task.id, subtask.id)


def test_task_token_can_read_own_plugin_submission(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    active_task_auth: tuple[str, TaskResource, Subtask],
) -> None:
    token, task, subtask = active_task_auth
    submission = _submission(
        test_db,
        test_user,
        task_id=task.id,
        subtask_id=subtask.id,
    )

    response = test_client.get(
        f"/api/plugins/submissions/{submission.id}",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "approved"


def test_task_token_cannot_initialize_after_subtask_finishes(
    test_client: TestClient,
    test_db: Session,
    active_task_auth: tuple[str, TaskResource, Subtask],
    mocker: MockerFixture,
) -> None:
    token, _task, subtask = active_task_auth
    subtask.status = SubtaskStatus.COMPLETED
    subtask.completed_at = datetime.now()
    test_db.commit()
    init_submission = mocker.patch(
        "app.api.endpoints.installed_plugins.plugin_marketplace_service.init_submission"
    )

    response = test_client.post(
        "/api/plugins/submissions/init",
        headers={"Authorization": f"Bearer {token}"},
        json=_init_request(),
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Task token is no longer active"
    init_submission.assert_not_called()


def test_task_token_cannot_read_submission_from_another_task(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    active_task_auth: tuple[str, TaskResource, Subtask],
) -> None:
    token, task, subtask = active_task_auth
    submission = _submission(
        test_db,
        test_user,
        task_id=task.id + 1,
        subtask_id=subtask.id + 1,
    )

    response = test_client.get(
        f"/api/plugins/submissions/{submission.id}",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 404
