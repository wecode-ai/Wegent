"""Metadata-only declarations for files generated in remote Task workspaces."""

import httpx
import pytest
from fastapi.testclient import TestClient
from pytest_mock import MockerFixture
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextType, SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.subtask_context import SubtaskContextBrief, SubtaskContextResponse
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
        executor_name="executor-a",
        executor_namespace="namespace-a",
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
        "workspace_root": "/workspace/original-repository",
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

    brief = SubtaskContextBrief.from_model(context)
    assert brief.model_dump(mode="json")["context_type"] == context.context_type
    assert brief.remote_task_id == task.id
    assert brief.remote_path == "outputs/report.pdf"
    assert SubtaskContextResponse.model_validate(context).context_type == (
        ContextType.REMOTE_WORKSPACE_ARTIFACT
    )


def test_declaration_captures_original_executor_and_workspace(
    test_client: TestClient, test_db: Session, test_user: User
) -> None:
    token, task, _subtask = _task_auth(test_db, test_user)

    response = test_client.post(
        f"/api/tasks/{task.id}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {token}"},
        json=_declaration(),
    )

    assert response.status_code == 200
    context = test_db.get(SubtaskContext, response.json()["id"])
    assert context.type_data["source"] == {
        "executor_name": "executor-a",
        "executor_namespace": "namespace-a",
        "workspace_root": "/workspace/original-repository",
    }


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


def test_redeclaration_cannot_move_an_existing_artifact_to_another_source(
    test_client: TestClient, test_db: Session, test_user: User
) -> None:
    token, task, subtask = _task_auth(test_db, test_user)
    url = f"/api/tasks/{task.id}/remote-workspace/artifacts"
    headers = {"Authorization": f"Bearer {token}"}
    original = test_client.post(url, headers=headers, json=_declaration()).json()
    subtask.executor_name = "executor-b"
    test_db.commit()

    response = test_client.post(
        url, headers=headers, json={**_declaration(), "sha256": "b" * 64}
    )

    assert response.status_code == 409
    context = test_db.get(SubtaskContext, original["id"])
    assert context.type_data["sha256"] == "a" * 64
    assert context.type_data["source"]["executor_name"] == "executor-a"


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


def test_download_does_not_grant_other_users_access_to_the_original_device(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
) -> None:
    token, task, _subtask = _task_auth(test_db, test_user)
    declaration = test_client.post(
        f"/api/tasks/{task.id}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {token}"},
        json=_declaration(),
    ).json()

    response = test_client.get(
        f"/api/tasks/{task.id}/remote-workspace/artifacts/{declaration['id']}/file",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 404


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


@pytest.mark.parametrize("original_available", [True, False])
def test_download_stays_on_original_executor_after_task_moves(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    mocker: MockerFixture,
    original_available: bool,
) -> None:
    task_token, task, subtask = _task_auth(test_db, test_user)
    declaration = test_client.post(
        f"/api/tasks/{task.id}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {task_token}"},
        json=_declaration(),
    ).json()
    # Recovery can rebind even the original subtask; declaration provenance is immutable.
    subtask.executor_name = "executor-b"
    subtask.executor_namespace = "namespace-b"
    test_db.commit()
    service_path = "app.services.remote_workspace_service.remote_workspace_service"
    mocker.patch(
        f"{service_path}._get_task_detail",
        return_value={"subtasks": [{"executor_name": "executor-b"}]},
    )
    mocker.patch(f"{service_path}._get_sandbox_payload", return_value=None)

    def executor_address(*, executor_name: str, executor_namespace: str = ""):
        if executor_name == "executor-a":
            assert executor_namespace == "namespace-a"
            if not original_available:
                return None
        return {"status": "success", "base_url": f"http://{executor_name}"}

    mocker.patch(f"{service_path}._get_executor_payload", side_effect=executor_address)
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/filesystem.Filesystem/Stat":
            return httpx.Response(
                200,
                json={
                    "entry": {
                        "path": "/workspace/other-repository",
                        "type": "FILE_TYPE_DIRECTORY",
                    }
                },
            )
        return httpx.Response(
            200,
            content=(
                b"original bytes"
                if request.url.host == "executor-a"
                else b"unrelated bytes"
            ),
        )

    transport = httpx.MockTransport(respond)
    sync_client, async_client = httpx.Client, httpx.AsyncClient
    mocker.patch(
        "httpx.Client", side_effect=lambda **kw: sync_client(transport=transport, **kw)
    )
    mocker.patch(
        "httpx.AsyncClient",
        side_effect=lambda **kw: async_client(transport=transport, **kw),
    )

    response = test_client.get(
        f"/api/tasks/{task.id}/remote-workspace/artifacts/{declaration['id']}/file",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    if original_available:
        assert response.status_code == 200
        assert response.content == b"original bytes"
        assert len(requests) == 1
        assert requests[0].url.path == "/filesystem/artifact"
        assert requests[0].url.params["root_path"] == "/workspace/original-repository"
        assert requests[0].url.params["path"] == "outputs/report.pdf"
        assert response.headers["Content-Disposition"].startswith("attachment;")
    else:
        assert response.status_code == 409
        assert requests == []


@pytest.mark.parametrize("available", [True, False])
def test_device_download_uses_original_owned_device_and_canonical_chunk_reader(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    mocker: MockerFixture,
    available: bool,
) -> None:
    from app.models.kind import Kind

    task_token, task, subtask = _task_auth(test_db, test_user)
    subtask.executor_name = "device-runner-a"
    subtask.executor_namespace = f"user-{test_user.id}"
    test_db.add(
        Kind(
            user_id=test_user.id,
            kind="Device",
            name="runner-a",
            namespace="default",
            json={"spec": {"deviceId": "runner-a", "deviceType": "local"}},
            is_active=available,
        )
    )
    test_db.commit()
    declaration = test_client.post(
        f"/api/tasks/{task.id}/remote-workspace/artifacts",
        headers={"Authorization": f"Bearer {task_token}"},
        json=_declaration(),
    ).json()
    subtask.executor_name = "device-runner-b"
    test_db.commit()
    rpc = mocker.patch(
        "app.services.device.command_service.local_device_command_service.execute_command",
        side_effect=[
            {
                "success": True,
                "stdout": {
                    "content_base64": "Zmlyc3Q=",
                    "offset": 0,
                    "size": 11,
                    "eof": False,
                },
            },
            {
                "success": True,
                "stdout": {
                    "content_base64": "c2Vjb25k",
                    "offset": 5,
                    "size": 11,
                    "eof": True,
                },
            },
        ],
    )

    response = test_client.get(
        f"/api/tasks/{task.id}/remote-workspace/artifacts/{declaration['id']}/file",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    if available:
        assert response.status_code == 200
        assert response.content == b"firstsecond"
        assert rpc.await_count == 2
        for call, offset in zip(rpc.await_args_list, ("0", "5")):
            assert call.kwargs["device_id"] == "runner-a"
            assert call.kwargs["path"] == "/workspace/original-repository"
            assert call.kwargs["command_key"] == "workspace_read_file_chunk"
            assert call.kwargs["args"] == ["outputs/report.pdf", offset]
    else:
        assert response.status_code == 409
        rpc.assert_not_called()
