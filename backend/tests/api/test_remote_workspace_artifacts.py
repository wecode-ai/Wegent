"""Metadata-only declarations for files generated in remote Task workspaces."""

from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from pytest_mock import MockerFixture
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextType, SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.remote_workspace import RemoteWorkspaceStatusResponse
from app.services.auth.task_token import create_task_token


def _task_auth(
    db: Session,
    user: User,
) -> tuple[str, TaskResource, Subtask]:
    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name="artifact-task",
        namespace="default",
        json={"status": {"status": "RUNNING"}},
        is_active=TaskResource.STATE_ACTIVE,
    )
    db.add(task)
    db.flush()
    subtask = Subtask(
        user_id=user.id,
        task_id=task.id,
        team_id=1,
        title="Create report",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.RUNNING,
    )
    db.add(subtask)
    db.commit()
    token = create_task_token(
        task_id=task.id,
        subtask_id=subtask.id,
        user_id=user.id,
        user_name=user.user_name,
    )
    return token, task, subtask


def _declaration() -> dict[str, object]:
    return {
        "relative_path": "outputs/report.pdf",
        "name": "report.pdf",
        "file_size": 4096,
        "mime_type": "application/pdf",
        "modified_at": 1_797_638_400,
        "sha256": "a" * 64,
    }


def test_declare_artifact_stores_metadata_without_file_bytes(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    token, task, subtask = _task_auth(test_db, test_user)

    response = test_client.post(
        f"/api/tasks/{task.id}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {token}"},
        json=_declaration(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["subtask_id"] == subtask.id
    assert payload["relative_path"] == "outputs/report.pdf"
    assert payload["download_url"].endswith(f"/{payload['id']}/file")
    context = test_db.get(SubtaskContext, payload["id"])
    assert context is not None
    assert context.context_type == ContextType.REMOTE_WORKSPACE_ARTIFACT.value
    assert context.binary_data == b""
    assert context.extracted_text == ""
    assert context.type_data["sha256"] == "a" * 64


def test_redeclaring_same_path_updates_existing_context(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    token, task, _subtask = _task_auth(test_db, test_user)
    url = f"/api/tasks/{task.id}/remote-workspace/artifacts"
    headers = {"Authorization": f"Bearer {token}"}
    first = test_client.post(url, headers=headers, json=_declaration())
    updated = {**_declaration(), "file_size": 8192, "sha256": "b" * 64}

    second = test_client.post(url, headers=headers, json=updated)

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["file_size"] == 8192
    contexts = (
        test_db.query(SubtaskContext)
        .filter(
            SubtaskContext.context_type == ContextType.REMOTE_WORKSPACE_ARTIFACT.value
        )
        .all()
    )
    assert len(contexts) == 1


def test_declaration_requires_task_token_matching_route_task(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    token, task, _subtask = _task_auth(test_db, test_user)

    response = test_client.post(
        f"/api/tasks/{task.id + 1}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {token}"},
        json=_declaration(),
    )

    assert response.status_code == 403


def test_declaration_rejects_parent_path(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    token, task, _subtask = _task_auth(test_db, test_user)
    declaration = {**_declaration(), "relative_path": "../report.pdf"}

    response = test_client.post(
        f"/api/tasks/{task.id}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {token}"},
        json=declaration,
    )

    assert response.status_code == 400


def test_download_resolves_declared_path_against_live_workspace_root(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    mocker: MockerFixture,
) -> None:
    task_token, task, _subtask = _task_auth(test_db, test_user)
    declaration = test_client.post(
        f"/api/tasks/{task.id}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {task_token}"},
        json=_declaration(),
    ).json()
    mocker.patch(
        "app.services.remote_workspace_artifact_service.remote_workspace_service.get_status",
        return_value=RemoteWorkspaceStatusResponse(
            connected=True,
            available=True,
            root_path=f"/workspace/{task.id}",
        ),
    )
    stream_file = mocker.patch(
        "app.services.remote_workspace_artifact_service.remote_workspace_service.stream_file",
        return_value=StreamingResponse(iter([b"report bytes"])),
    )

    response = test_client.get(
        f"/api/tasks/{task.id}/remote-workspace/artifacts/{declaration['id']}/file",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 200
    assert response.content == b"report bytes"
    assert stream_file.call_args.kwargs["path"] == (
        f"/workspace/{task.id}/outputs/report.pdf"
    )
    assert stream_file.call_args.kwargs["disposition"] == "attachment"
