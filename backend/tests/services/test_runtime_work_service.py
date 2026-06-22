# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.kind import Kind
from app.models.project import Project
from app.models.task import TaskResource


def _project(test_db, user_id: int, name: str = "Wegent") -> Project:
    project = Project(
        user_id=user_id,
        name=name,
        client_origin=CLIENT_ORIGIN_WEWORK,
        config={"mode": "workspace"},
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def _local_path_project(
    test_db,
    user_id: int,
    *,
    device_id: str = "device-1",
    path: str = "/repo/Wegent",
    name: str = "Wegent",
) -> Project:
    project = Project(
        user_id=user_id,
        name=name,
        client_origin=CLIENT_ORIGIN_WEWORK,
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": device_id},
            "workspace": {"source": "local_path", "localPath": path},
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def _git_project(test_db, user_id: int, name: str = "Wegent") -> Project:
    project = Project(
        user_id=user_id,
        name=name,
        client_origin=CLIENT_ORIGIN_WEWORK,
        config={
            "mode": "workspace",
            "git": {
                "url": "https://github.com/wecode-ai/Wegent.git",
                "repo": "wecode-ai/Wegent",
                "domain": "github.com",
                "branch": "main",
            },
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def _git_status_command(
    statuses: dict[tuple[str, str], dict],
    *,
    reachable_commits: set[tuple[str, str, str]] | None = None,
    calls: list[dict] | None = None,
):
    reachable_commits = reachable_commits or set()

    async def command(**kwargs):
        call = {
            "device_id": kwargs["device_id"],
            "command_key": kwargs["command_key"],
            "args": kwargs["args"],
        }
        if calls is not None:
            calls.append(call)

        if kwargs["command_key"] == "project_folder_status":
            status = statuses[(kwargs["device_id"], kwargs["args"][0])]
            return {
                "success": True,
                "exit_code": 0,
                "stdout": {
                    "exists": True,
                    "isDirectory": True,
                    "isEmpty": False,
                    "isGitRepo": True,
                    **status,
                },
            }
        if kwargs["command_key"] == "git_commit_available":
            key = (kwargs["device_id"], kwargs["args"][0], kwargs["args"][1])
            if key in reachable_commits:
                return {"success": True, "exit_code": 0, "stdout": ""}
            return {"success": False, "exit_code": 1, "stderr": "missing"}
        if kwargs["command_key"] == "git_worktree_add":
            return {"success": True, "exit_code": 0, "stdout": ""}
        raise AssertionError(kwargs["command_key"])

    return command


def _expected_runtime_fork_worktree_path(target_path: str, transfer_id: str) -> str:
    parent, project_dir = target_path.rstrip("/").rsplit("/", maxsplit=1)
    return f"{parent}/worktrees/{transfer_id}/{project_dir}"


@pytest.mark.asyncio
async def test_device_workspace_upsert_normalizes_unique_mapping(test_db, test_user):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)

    first = runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent/",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="MacBook",
        ),
    )
    second = runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
            label="Renamed",
        ),
    )

    assert second.id == first.id
    assert second.workspace_path == "/repo/Wegent"
    assert second.label == "Renamed"

    mappings = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "DeviceWorkspace",
            Kind.namespace == "runtime-work",
            Kind.is_active == True,
        )
        .all()
    )
    assert len(mappings) == 1
    assert mappings[0].id == first.id
    assert mappings[0].json["spec"]["projectId"] == project.id
    assert mappings[0].json["spec"]["deviceId"] == "device-1"
    assert mappings[0].json["spec"]["workspacePath"] == "/repo/Wegent"

    rows = runtime_work_service.list_device_workspaces(
        db=test_db,
        user_id=test_user.id,
        project_id=project.id,
    )
    assert [row.id for row in rows] == [first.id]


@pytest.mark.asyncio
async def test_device_workspace_upsert_reactivates_inactive_mapping(test_db, test_user):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    first = runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
            label="MacBook",
        ),
    )
    row = test_db.get(Kind, first.id)
    row.is_active = False
    test_db.commit()

    restored = runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent/",
            label="Restored",
        ),
    )

    assert restored.id == first.id
    assert restored.label == "Restored"
    rows = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "DeviceWorkspace",
            Kind.namespace == "runtime-work",
        )
        .all()
    )
    assert len(rows) == 1
    assert rows[0].is_active is True


@pytest.mark.asyncio
async def test_prepare_plain_device_workspace_creates_directory_and_mapping(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspacePrepareRequest
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    calls: list[tuple[str, list[str]]] = []

    async def execute(**kwargs):
        calls.append((kwargs["command_key"], kwargs.get("args") or []))
        if kwargs["command_key"] == "project_folder_status":
            return {"success": True, "exit_code": 0, "stdout": '{"exists": false}'}
        return {"success": True, "exit_code": 0, "stdout": ""}

    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", execute
    )

    response = await runtime_work_service.prepare_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspacePrepareRequest(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
            action="create",
        ),
    )

    assert response.mapping.project_id == project.id
    assert response.mapping.workspace_path == "/repo/Wegent"
    assert response.mapping.repo_url is None
    assert response.prepared_action == "created"
    assert calls == [
        ("project_folder_status", ["/repo/Wegent"]),
        ("mkdir_p", ["/repo/Wegent"]),
    ]


@pytest.mark.asyncio
async def test_prepare_git_device_workspace_clones_into_empty_directory(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspacePrepareRequest
    from app.services import runtime_work_service

    project = _git_project(test_db, test_user.id)
    calls: list[tuple[str, list[str]]] = []

    async def execute(**kwargs):
        calls.append((kwargs["command_key"], kwargs.get("args") or []))
        if kwargs["command_key"] == "project_folder_status":
            return {
                "success": True,
                "exit_code": 0,
                "stdout": (
                    '{"exists": true, "isDirectory": true, "isEmpty": true, '
                    '"isGitRepo": false, "remoteUrl": null}'
                ),
            }
        return {"success": True, "exit_code": 0, "stdout": ""}

    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", execute
    )

    response = await runtime_work_service.prepare_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspacePrepareRequest(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
            action="select",
        ),
    )

    assert response.mapping.repo_url == "https://github.com/wecode-ai/Wegent.git"
    assert response.prepared_action == "cloned"
    assert (
        "git_clone",
        [
            "--branch",
            "main",
            "--single-branch",
            "https://github.com/wecode-ai/Wegent.git",
            "/repo/Wegent",
        ],
    ) in calls


@pytest.mark.asyncio
async def test_prepare_git_device_workspace_rejects_nonmatching_nonempty_directory(
    test_db,
    test_user,
    monkeypatch,
):
    from fastapi import HTTPException

    from app.schemas.runtime_work import DeviceWorkspacePrepareRequest
    from app.services import runtime_work_service

    project = _git_project(test_db, test_user.id)

    async def execute(**kwargs):
        assert kwargs["command_key"] == "project_folder_status"
        return {
            "success": True,
            "exit_code": 0,
            "stdout": (
                '{"exists": true, "isDirectory": true, "isEmpty": false, '
                '"isGitRepo": true, "remoteUrl": "https://github.com/other/repo.git"}'
            ),
        }

    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", execute
    )

    with pytest.raises(HTTPException) as exc:
        await runtime_work_service.prepare_device_workspace(
            db=test_db,
            user_id=test_user.id,
            payload=DeviceWorkspacePrepareRequest(
                projectId=project.id,
                deviceId="device-1",
                workspacePath="/repo/Wegent",
                action="select",
            ),
        )

    assert exc.value.status_code == 409
    assert "other repository" in exc.value.detail
    assert test_db.query(Kind).filter(Kind.kind == "DeviceWorkspace").count() == 0


@pytest.mark.asyncio
async def test_list_runtime_work_groups_local_tasks_under_device_workspaces(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
            label="MacBook",
        ),
    )

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_all_devices",
        AsyncMock(
            return_value=[
                {
                    "device_id": "device-1",
                    "name": "MacBook",
                    "status": "online",
                    "device_type": "local",
                }
            ]
        ),
    )
    rpc = AsyncMock(
        return_value={
            "workspaces": [
                {
                    "workspacePath": "/repo/Wegent",
                    "localTasks": [
                        {
                            "localTaskId": "codex-1",
                            "workspacePath": "/repo/Wegent",
                            "title": "Fix reconnect",
                            "runtime": "codex",
                            "createdAt": "2026-06-20T01:00:00Z",
                            "updatedAt": "2026-06-20T02:00:00Z",
                            "running": False,
                        }
                    ],
                },
                {
                    "workspacePath": "/tmp/spike",
                    "localTasks": [
                        {
                            "localTaskId": "claude-1",
                            "workspacePath": "/tmp/spike",
                            "title": "Spike",
                            "runtime": "claude_code",
                            "createdAt": "2026-06-20T03:00:00Z",
                            "updatedAt": "2026-06-20T04:00:00Z",
                            "running": True,
                        }
                    ],
                },
            ]
        }
    )
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.list_runtime_work(
        db=test_db,
        user_id=test_user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )

    assert response.total_local_tasks == 2
    assert response.projects[0].project.id == project.id
    assert response.projects[0].device_workspaces[0].workspace_path == "/repo/Wegent"
    assert (
        response.projects[0].device_workspaces[0].local_tasks[0].local_task_id
        == "codex-1"
    )
    assert response.unmapped_device_workspaces[0].workspace_path == "/tmp/spike"
    assert (
        response.unmapped_device_workspaces[0].local_tasks[0].runtime == "claude_code"
    )
    rpc.assert_awaited_once()
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_list_runtime_work_uses_mapping_label_as_workspace_kind(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
            label="worktree",
        ),
    )

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_all_devices",
        AsyncMock(
            return_value=[
                {
                    "device_id": "device-1",
                    "name": "MacBook",
                    "status": "online",
                    "device_type": "local",
                }
            ]
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.runtime_rpc_service,
        "call",
        AsyncMock(return_value={"workspaces": []}),
    )

    response = await runtime_work_service.list_runtime_work(
        db=test_db,
        user_id=test_user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )

    workspace = response.projects[0].device_workspaces[0]
    assert workspace.workspace_path == "/repo/Wegent"
    assert workspace.label == "worktree"
    assert workspace.workspace_kind == "worktree"


@pytest.mark.asyncio
async def test_list_runtime_work_matches_project_configured_local_directory_without_mapping_row(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import runtime_work_service

    project = _local_path_project(test_db, test_user.id)

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_all_devices",
        AsyncMock(
            return_value=[
                {
                    "device_id": "device-1",
                    "name": "MacBook",
                    "status": "online",
                    "device_type": "local",
                }
            ]
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.runtime_rpc_service,
        "call",
        AsyncMock(
            return_value={
                "workspaces": [
                    {
                        "workspacePath": "/repo/Wegent",
                        "localTasks": [
                            {
                                "localTaskId": "018f2d6b-8c7a-7abc-9def-0123456789ab",
                                "workspacePath": "/repo/Wegent",
                                "title": "Implement runtime sidebar",
                                "runtime": "codex",
                                "updatedAt": "2026-06-20T02:00:00Z",
                            }
                        ],
                    },
                    {
                        "workspacePath": (
                            "/Users/axb-mac/.wecode/wegent-executor/workspace/"
                            "chats/2026-06-20/hi-1"
                        ),
                        "localTasks": [
                            {
                                "localTaskId": "019ee579-f6f4-73d3-9b3e-2d4652e0c9e9",
                                "workspacePath": (
                                    "/Users/axb-mac/.wecode/wegent-executor/"
                                    "workspace/chats/2026-06-20/hi-1"
                                ),
                                "title": "hi",
                                "runtime": "codex",
                                "updatedAt": "2026-06-20T14:40:46+00:00",
                            }
                        ],
                    },
                ]
            }
        ),
    )

    response = await runtime_work_service.list_runtime_work(
        db=test_db,
        user_id=test_user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )

    workspace = response.projects[0].device_workspaces[0]
    assert response.projects[0].project.id == project.id
    assert workspace.device_id == "device-1"
    assert workspace.workspace_path == "/repo/Wegent"
    assert workspace.local_tasks[0].title == "Implement runtime sidebar"
    assert len(response.unmapped_device_workspaces) == 1
    assert (
        response.unmapped_device_workspaces[0].workspace_path
        == "/Users/axb-mac/.wecode/wegent-executor/workspace/chats/2026-06-20/hi-1"
    )
    assert response.unmapped_device_workspaces[0].workspace_kind == "chat"
    assert response.unmapped_device_workspaces[0].local_tasks[0].title == "hi"
    assert (
        response.unmapped_device_workspaces[0].local_tasks[0].workspace_kind == "chat"
    )
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_list_runtime_work_groups_managed_worktree_under_source_project(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import runtime_work_service

    project = _local_path_project(
        test_db,
        test_user.id,
        path="/workspace/Wegent",
        name="Wegent",
    )

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_all_devices",
        AsyncMock(
            return_value=[
                {
                    "device_id": "device-1",
                    "name": "MacBook",
                    "status": "online",
                    "device_type": "local",
                }
            ]
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.runtime_rpc_service,
        "call",
        AsyncMock(
            return_value={
                "workspaces": [
                    {
                        "workspacePath": "/workspace/worktrees/42/Wegent",
                        "localTasks": [
                            {
                                "localTaskId": "codex-worktree",
                                "workspacePath": "/workspace/worktrees/42/Wegent",
                                "title": "Fix worktree sidebar",
                                "runtime": "codex",
                                "updatedAt": "2026-06-20T02:00:00Z",
                            }
                        ],
                    }
                ]
            }
        ),
    )

    response = await runtime_work_service.list_runtime_work(
        db=test_db,
        user_id=test_user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )

    worktree_workspace = response.projects[0].device_workspaces[0]
    task = worktree_workspace.local_tasks[0]
    assert response.projects[0].project.id == project.id
    assert worktree_workspace.workspace_path == "/workspace/Wegent"
    assert worktree_workspace.workspace_kind == "workspace"
    assert worktree_workspace.worktree_id is None
    assert task.local_task_id == "codex-worktree"
    assert task.workspace_path == "/workspace/worktrees/42/Wegent"
    assert task.workspace_kind == "worktree"
    assert task.worktree_id == "42"
    assert response.unmapped_device_workspaces == []
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_list_runtime_work_groups_mapped_device_worktree_under_project(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert
    from app.services import runtime_work_service

    project = _git_project(test_db, test_user.id, name="Wegent_github")
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="target-device",
            workspacePath="/target/Wegent_github",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_all_devices",
        AsyncMock(
            return_value=[
                {
                    "device_id": "target-device",
                    "name": "Linux",
                    "status": "online",
                    "device_type": "local",
                }
            ]
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.runtime_rpc_service,
        "call",
        AsyncMock(
            return_value={
                "workspaces": [
                    {
                        "workspacePath": "/target/worktrees/019eeb2c/Wegent_github",
                        "localTasks": [
                            {
                                "localTaskId": "forked-codex",
                                "workspacePath": (
                                    "/target/worktrees/019eeb2c/Wegent_github"
                                ),
                                "title": "Forked Codex task",
                                "runtime": "codex",
                                "updatedAt": "2026-06-22T02:00:00Z",
                            }
                        ],
                    }
                ]
            }
        ),
    )

    response = await runtime_work_service.list_runtime_work(
        db=test_db,
        user_id=test_user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )

    workspace = response.projects[0].device_workspaces[0]
    task = workspace.local_tasks[0]
    assert response.projects[0].project.id == project.id
    assert workspace.device_id == "target-device"
    assert workspace.workspace_path == "/target/Wegent_github"
    assert task.local_task_id == "forked-codex"
    assert task.workspace_path == "/target/worktrees/019eeb2c/Wegent_github"
    assert task.workspace_kind == "worktree"
    assert task.worktree_id == "019eeb2c"
    assert response.unmapped_device_workspaces == []
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_list_runtime_work_groups_codex_git_origin_under_matching_project(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert
    from app.services import runtime_work_service

    project = _local_path_project(
        test_db,
        test_user.id,
        path="/workspace/Wegent",
        name="Wegent",
    )
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/workspace/Wegent",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
        ),
    )

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_all_devices",
        AsyncMock(
            return_value=[
                {
                    "device_id": "device-1",
                    "name": "MacBook",
                    "status": "online",
                    "device_type": "local",
                }
            ]
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.runtime_rpc_service,
        "call",
        AsyncMock(
            return_value={
                "workspaces": [
                    {
                        "workspacePath": "/Users/alice/dev/other/Wegent",
                        "localTasks": [
                            {
                                "localTaskId": "codex-git-origin",
                                "workspacePath": "/Users/alice/dev/other/Wegent",
                                "title": "Fix Git grouped task",
                                "runtime": "codex",
                                "gitInfo": {
                                    "originUrl": "git@github.com:wecode-ai/Wegent.git"
                                },
                                "updatedAt": "2026-06-20T02:00:00Z",
                            }
                        ],
                    }
                ]
            }
        ),
    )

    response = await runtime_work_service.list_runtime_work(
        db=test_db,
        user_id=test_user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )

    workspace = response.projects[0].device_workspaces[0]
    task = workspace.local_tasks[0]
    assert response.projects[0].project.id == project.id
    assert workspace.workspace_path == "/workspace/Wegent"
    assert task.local_task_id == "codex-git-origin"
    assert task.workspace_path == "/Users/alice/dev/other/Wegent"
    assert response.unmapped_device_workspaces == []
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_open_runtime_transcript_dispatches_to_owned_mapped_device_without_task_rows(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert, RuntimeTaskAddress
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    rpc = AsyncMock(
        return_value={
            "localTaskId": "codex-1",
            "workspacePath": "/repo/Wegent",
            "runtime": "codex",
            "messages": [
                {
                    "id": "m1",
                    "role": "user",
                    "content": "hello",
                    "subtaskId": 2001,
                    "createdAt": "2026-06-20T01:00:00Z",
                }
            ],
        }
    )
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.get_runtime_transcript(
        db=test_db,
        user_id=test_user.id,
        address=RuntimeTaskAddress(
            deviceId="device-1",
            localTaskId="codex-1",
        ),
    )

    assert response.local_task_id == "codex-1"
    assert response.messages[0].content == "hello"
    assert response.model_dump(by_alias=True)["messages"][0]["subtaskId"] == 2001
    rpc.assert_awaited_once_with(
        user_id=test_user.id,
        device_id="device-1",
        method="runtime.tasks.transcript",
        payload={
            "deviceId": "device-1",
            "localTaskId": "codex-1",
        },
        timeout_seconds=30,
    )
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_archive_runtime_task_dispatches_to_owned_device_without_task_rows(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import RuntimeTaskAddress
    from app.services import runtime_work_service

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    rpc = AsyncMock(
        return_value={
            "success": True,
            "accepted": True,
            "localTaskId": "codex-1",
            "workspacePath": "/repo/Wegent",
        }
    )
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.archive_runtime_task(
        db=test_db,
        user_id=test_user.id,
        address=RuntimeTaskAddress(
            deviceId="device-1",
            localTaskId="codex-1",
        ),
    )

    assert response.accepted is True
    assert response.local_task_id == "codex-1"
    rpc.assert_awaited_once_with(
        user_id=test_user.id,
        device_id="device-1",
        method="runtime.tasks.archive",
        payload={
            "deviceId": "device-1",
            "localTaskId": "codex-1",
        },
        timeout_seconds=30,
    )
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_send_runtime_message_normalizes_runtime_rpc_failure_without_task_rows(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import (
        DeviceWorkspaceUpsert,
        RuntimeSendRequest,
        RuntimeTaskAddress,
    )
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    rpc = AsyncMock(
        return_value={
            "success": False,
            "error": "Runtime send adapter is not available",
        }
    )
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.send_runtime_message(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeSendRequest(
            address=RuntimeTaskAddress(
                deviceId="device-1",
                localTaskId="codex-1",
            ),
            message="continue",
        ),
    )

    assert response.accepted is False
    assert response.local_task_id == "codex-1"
    assert response.error == "Runtime send adapter is not available"
    rpc.assert_awaited_once_with(
        user_id=test_user.id,
        device_id="device-1",
        method="runtime.tasks.send",
        payload={
            "deviceId": "device-1",
            "localTaskId": "codex-1",
            "message": "continue",
        },
        timeout_seconds=600,
    )
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_create_runtime_task_dispatches_to_project_device_without_task_rows(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import RuntimeTaskCreateRequest
    from app.services import runtime_work_service

    project = _local_path_project(test_db, test_user.id)
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service,
        "_build_runtime_execution_request",
        lambda **kwargs: SimpleNamespace(
            to_dict=lambda: {
                "task_id": 1001,
                "subtask_id": 2001,
                "team_id": kwargs["request"].team_id,
                "prompt": kwargs["request"].message,
                "workspace_source": "local_path",
                "project_workspace_path": "/repo/Wegent",
            }
        ),
    )
    rpc = AsyncMock(
        return_value={
            "success": True,
            "accepted": True,
            "localTaskId": "runtime-1",
            "workspacePath": "/repo/Wegent",
            "runtime": "claude_code",
        }
    )
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.create_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskCreateRequest(
            projectId=project.id,
            teamId=3,
            runtime="claude_code",
            message="create runtime task",
            title="Create runtime task",
        ),
    )

    assert response.accepted is True
    assert response.local_task_id == "runtime-1"
    assert response.device_id == "device-1"
    rpc.assert_awaited_once_with(
        user_id=test_user.id,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={
            "runtime": "claude_code",
            "workspacePath": "/repo/Wegent",
            "message": "create runtime task",
            "title": "Create runtime task",
            "executionRequest": {
                "task_id": 1001,
                "subtask_id": 2001,
                "team_id": 3,
                "prompt": "create runtime task",
                "workspace_source": "local_path",
                "project_workspace_path": "/repo/Wegent",
            },
        },
        timeout_seconds=600,
    )
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_create_runtime_task_uses_device_workspace_id_as_trusted_target(
    test_db,
    test_user,
    monkeypatch,
):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert, RuntimeTaskCreateRequest
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    mapping = runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="device-1",
            workspacePath="/repo/Wegent",
            label="workspace",
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service,
        "_build_runtime_execution_request",
        lambda **kwargs: SimpleNamespace(
            to_dict=lambda: {
                "team_id": kwargs["request"].team_id,
                "prompt": kwargs["request"].message,
                "project_workspace_path": kwargs["target"].workspace_path,
            }
        ),
    )
    rpc = AsyncMock(
        return_value={
            "success": True,
            "accepted": True,
            "localTaskId": "runtime-1",
            "workspacePath": "/repo/Wegent",
            "runtime": "claude_code",
        }
    )
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.create_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskCreateRequest(
            projectId=project.id,
            deviceWorkspaceId=mapping.id,
            teamId=3,
            runtime="claude_code",
            message="create runtime task",
        ),
    )

    assert response.accepted is True
    assert response.device_id == "device-1"
    assert response.workspace_path == "/repo/Wegent"
    rpc.assert_awaited_once_with(
        user_id=test_user.id,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={
            "runtime": "claude_code",
            "workspacePath": "/repo/Wegent",
            "message": "create runtime task",
            "title": "create runtime task",
            "executionRequest": {
                "team_id": 3,
                "prompt": "create runtime task",
                "project_workspace_path": "/repo/Wegent",
            },
        },
        timeout_seconds=600,
    )


@pytest.mark.asyncio
async def test_create_runtime_task_rejects_device_workspace_from_another_project(
    test_db,
    test_user,
):
    from app.schemas.runtime_work import DeviceWorkspaceUpsert, RuntimeTaskCreateRequest
    from app.services import runtime_work_service

    source_project = _project(test_db, test_user.id, name="Source")
    target_project = _project(test_db, test_user.id, name="Target")
    mapping = runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=source_project.id,
            deviceId="device-1",
            workspacePath="/repo/Source",
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await runtime_work_service.create_runtime_task(
            db=test_db,
            user_id=test_user.id,
            request=RuntimeTaskCreateRequest(
                projectId=target_project.id,
                deviceWorkspaceId=mapping.id,
                teamId=3,
                runtime="claude_code",
                message="create runtime task",
            ),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Device workspace does not belong to project"


@pytest.mark.asyncio
async def test_fork_runtime_task_uses_git_workspace_without_storage(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from app.schemas.runtime_work import (
        DeviceWorkspaceUpsert,
        RuntimeTaskAddress,
        RuntimeTaskForkRequest,
    )
    from app.services import runtime_work_service

    project = _git_project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="source-device",
            workspacePath="/source/Wegent",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="target-device",
            workspacePath="/target/Wegent",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )
    calls = []
    command_calls = []
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_upload_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used for git workspace forks")
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_download_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used for git workspace forks")
        ),
    )

    command = _git_status_command(
        {
            (
                "source-device",
                "/Users/alice/.codex/worktrees/0889/Wegent",
            ): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "abc123",
            },
            ("target-device", "/target/Wegent"): {
                "remoteUrl": "git@github.com:wecode-ai/Wegent.git",
                "headCommit": "def456",
            },
        },
        reachable_commits={("target-device", "/target/Wegent", "abc123")},
        calls=command_calls,
    )

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            assert kwargs["payload"]["workspaceTransfer"] == "git_workspace"
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {
                        "mode": "git_workspace",
                        "transferId": kwargs["payload"]["transferId"],
                    },
                },
            }
        if kwargs["method"] == "runtime.tasks.import_fork":
            assert kwargs["payload"]["forkPackage"]["archive"] == {
                "mode": "git_workspace",
                "transferId": calls[0]["payload"]["transferId"],
            }
            expected_target_path = _expected_runtime_fork_worktree_path(
                "/target/Wegent",
                calls[0]["payload"]["transferId"],
            )
            assert kwargs["payload"]["workspacePath"] == expected_target_path
            return {
                "success": True,
                "accepted": True,
                "localTaskId": "runtime-copy",
                "workspacePath": kwargs["payload"]["workspacePath"],
                "runtime": "codex",
            }
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)
    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", command
    )

    response = await runtime_work_service.fork_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskForkRequest(
            source=RuntimeTaskAddress(
                deviceId="source-device",
                workspacePath="/Users/alice/.codex/worktrees/0889/Wegent",
                localTaskId="codex-1",
            ),
            target={
                "deviceId": "target-device",
                "workspacePath": "/target/Wegent",
            },
        ),
    )

    assert response.accepted is True
    assert response.target.local_task_id == "runtime-copy"
    transfer_id = calls[0]["payload"]["transferId"]
    expected_target_path = _expected_runtime_fork_worktree_path(
        "/target/Wegent",
        transfer_id,
    )
    assert response.target.workspace_path == expected_target_path
    assert [call["method"] for call in calls] == [
        "runtime.tasks.prepare_fork_transfer",
        "runtime.tasks.import_fork",
    ]
    assert test_db.query(TaskResource).count() == 0
    assert command_calls == [
        {
            "device_id": "source-device",
            "command_key": "project_folder_status",
            "args": ["/Users/alice/.codex/worktrees/0889/Wegent"],
        },
        {
            "device_id": "target-device",
            "command_key": "project_folder_status",
            "args": ["/target/Wegent"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_commit_available",
            "args": ["/target/Wegent", "abc123"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_worktree_add",
            "args": ["/target/Wegent", expected_target_path, "abc123"],
        },
    ]


@pytest.mark.asyncio
async def test_fork_runtime_task_uses_archive_when_git_commit_unreachable(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from app.schemas.runtime_work import (
        DeviceWorkspaceUpsert,
        RuntimeTaskAddress,
        RuntimeTaskForkRequest,
    )
    from app.services import runtime_work_service

    project = _git_project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="target-device",
            workspacePath="/target/Wegent",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )
    calls = []
    command_calls = []
    command = _git_status_command(
        {
            ("source-device", "/source/Wegent"): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "abc123",
            },
            ("target-device", "/target/Wegent"): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "def456",
            },
        },
        reachable_commits={("target-device", "/target/Wegent", "abc123")},
        calls=command_calls,
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_upload_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("direct transfer should run before object storage")
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_download_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("direct transfer should run before object storage")
        ),
    )

    async def command(**kwargs):
        if kwargs["command_key"] == "project_folder_status":
            return {
                "success": True,
                "exit_code": 0,
                "stdout": {
                    "exists": True,
                    "isDirectory": True,
                    "isEmpty": False,
                    "isGitRepo": True,
                    "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                    "headCommit": "abc123",
                },
            }
        if kwargs["command_key"] == "git_commit_available":
            return {"success": False, "exit_code": 1, "stderr": "missing"}
        raise AssertionError(kwargs["command_key"])

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            assert "workspaceTransfer" not in kwargs["payload"]
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {
                        "directUrls": ["http://source/archive"],
                        "directToken": "source-token",
                    },
                },
            }
        if (
            kwargs["method"] == "runtime.tasks.import_fork"
            and len(
                [
                    call
                    for call in calls
                    if call["method"] == "runtime.tasks.import_fork"
                ]
            )
            == 1
        ):
            return {"success": False, "error": "direct transfer failed"}
        if kwargs["method"] == "runtime.tasks.prepare_fork_receiver":
            return {
                "success": True,
                "accepted": True,
                "transferId": kwargs["payload"]["transferId"],
                "uploadUrls": ["http://target/upload"],
            }
        if kwargs["method"] == "runtime.tasks.push_fork_transfer":
            return {"success": True, "accepted": True}
        if kwargs["method"] == "runtime.tasks.import_fork":
            return {
                "success": True,
                "accepted": True,
                "localTaskId": "runtime-copy",
                "workspacePath": "/target/Wegent",
                "runtime": "codex",
            }
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)
    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", command
    )

    response = await runtime_work_service.fork_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskForkRequest(
            source=RuntimeTaskAddress(
                deviceId="source-device",
                workspacePath="/Users/alice/.codex/worktrees/0889/Wegent",
                localTaskId="codex-1",
            ),
            target={
                "deviceId": "target-device",
                "workspacePath": "/target/Wegent",
            },
        ),
    )

    assert response.accepted is True
    assert [call["method"] for call in calls] == [
        "runtime.tasks.prepare_fork_transfer",
        "runtime.tasks.import_fork",
        "runtime.tasks.prepare_fork_receiver",
        "runtime.tasks.push_fork_transfer",
        "runtime.tasks.import_fork",
    ]


@pytest.mark.asyncio
async def test_fork_runtime_task_without_source_workspace_path_resolves_git_workspace(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from app.schemas.runtime_work import (
        DeviceWorkspaceUpsert,
        RuntimeTaskAddress,
        RuntimeTaskForkRequest,
    )
    from app.services import runtime_work_service

    project = _git_project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="source-device",
            workspacePath="/source/Wegent",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="target-device",
            workspacePath="/target/Wegent",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )
    calls = []
    command_calls = []
    command = _git_status_command(
        {
            ("source-device", "/source/Wegent"): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "abc123",
            },
            ("target-device", "/target/Wegent"): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "def456",
            },
        },
        reachable_commits={("target-device", "/target/Wegent", "abc123")},
        calls=command_calls,
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.list":
            return {
                "success": True,
                "workspaces": [
                    {
                        "workspacePath": "/source/Wegent",
                        "localTasks": [
                            {
                                "localTaskId": "codex-1",
                                "workspacePath": "/source/Wegent",
                                "title": "Continue migration",
                                "runtime": "codex",
                                "createdAt": "2026-06-22T00:00:00Z",
                                "updatedAt": "2026-06-22T00:00:00Z",
                            }
                        ],
                    }
                ],
            }
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            assert kwargs["payload"]["workspacePath"] == "/source/Wegent"
            assert kwargs["payload"]["workspaceTransfer"] == "git_workspace"
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {
                        "mode": "git_workspace",
                        "transferId": kwargs["payload"]["transferId"],
                    },
                },
            }
        if kwargs["method"] == "runtime.tasks.import_fork":
            assert kwargs["payload"]["source"]["workspacePath"] == "/source/Wegent"
            expected_target_path = _expected_runtime_fork_worktree_path(
                "/target/Wegent",
                calls[1]["payload"]["transferId"],
            )
            assert kwargs["payload"]["workspacePath"] == expected_target_path
            return {
                "success": True,
                "accepted": True,
                "localTaskId": "runtime-copy",
                "workspacePath": kwargs["payload"]["workspacePath"],
                "runtime": "codex",
            }
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)
    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", command
    )

    response = await runtime_work_service.fork_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskForkRequest(
            source=RuntimeTaskAddress(
                deviceId="source-device",
                localTaskId="codex-1",
            ),
            target={
                "deviceId": "target-device",
                "workspacePath": "/target/Wegent",
            },
        ),
    )

    assert response.accepted is True
    assert [call["method"] for call in calls] == [
        "runtime.tasks.list",
        "runtime.tasks.prepare_fork_transfer",
        "runtime.tasks.import_fork",
    ]
    transfer_id = calls[1]["payload"]["transferId"]
    expected_target_path = _expected_runtime_fork_worktree_path(
        "/target/Wegent",
        transfer_id,
    )
    assert response.target.workspace_path == expected_target_path
    assert command_calls == [
        {
            "device_id": "source-device",
            "command_key": "project_folder_status",
            "args": ["/source/Wegent"],
        },
        {
            "device_id": "target-device",
            "command_key": "project_folder_status",
            "args": ["/target/Wegent"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_commit_available",
            "args": ["/target/Wegent", "abc123"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_worktree_add",
            "args": ["/target/Wegent", expected_target_path, "abc123"],
        },
    ]


@pytest.mark.asyncio
async def test_fork_runtime_task_uses_target_git_project_for_unmapped_worktree(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from app.schemas.runtime_work import (
        DeviceWorkspaceUpsert,
        RuntimeTaskAddress,
        RuntimeTaskForkRequest,
    )
    from app.services import runtime_work_service

    project = _git_project(test_db, test_user.id, name="Wegent_github")
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="source-device",
            workspacePath="/source/Wegent_github",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="target-device",
            workspacePath="/target/Wegent_github",
            repoUrl="https://github.com/wecode-ai/Wegent.git",
            label="workspace",
        ),
    )
    calls = []
    command_calls = []
    command = _git_status_command(
        {
            (
                "source-device",
                "/Users/alice/.codex/worktrees/0889/Wegent",
            ): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "abc123",
            },
            ("target-device", "/target/Wegent_github"): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "def456",
            },
        },
        reachable_commits={("target-device", "/target/Wegent_github", "abc123")},
        calls=command_calls,
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_upload_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used for git workspace forks")
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_download_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used for git workspace forks")
        ),
    )

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.list":
            return {
                "success": True,
                "workspaces": [
                    {
                        "workspacePath": "/Users/alice/.codex/worktrees/0889/Wegent",
                        "localTasks": [
                            {
                                "localTaskId": "codex-1",
                                "workspacePath": (
                                    "/Users/alice/.codex/worktrees/0889/Wegent"
                                ),
                                "title": "Continue migration",
                                "runtime": "codex",
                                "createdAt": "2026-06-22T00:00:00Z",
                                "updatedAt": "2026-06-22T00:00:00Z",
                            }
                        ],
                    }
                ],
            }
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            assert kwargs["payload"]["workspacePath"] == (
                "/Users/alice/.codex/worktrees/0889/Wegent"
            )
            assert kwargs["payload"]["workspaceTransfer"] == "git_workspace"
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {
                        "mode": "git_workspace",
                        "transferId": kwargs["payload"]["transferId"],
                    },
                },
            }
        if kwargs["method"] == "runtime.tasks.import_fork":
            expected_target_path = _expected_runtime_fork_worktree_path(
                "/target/Wegent_github",
                calls[1]["payload"]["transferId"],
            )
            assert kwargs["payload"]["workspacePath"] == expected_target_path
            return {
                "success": True,
                "accepted": True,
                "localTaskId": "runtime-copy",
                "workspacePath": kwargs["payload"]["workspacePath"],
                "runtime": "codex",
            }
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)
    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", command
    )

    response = await runtime_work_service.fork_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskForkRequest(
            source=RuntimeTaskAddress(
                deviceId="source-device",
                localTaskId="codex-1",
            ),
            target={
                "deviceId": "target-device",
                "workspacePath": "/target/Wegent_github",
            },
        ),
    )

    assert response.accepted is True
    assert [call["method"] for call in calls] == [
        "runtime.tasks.list",
        "runtime.tasks.prepare_fork_transfer",
        "runtime.tasks.import_fork",
    ]
    transfer_id = calls[1]["payload"]["transferId"]
    expected_target_path = _expected_runtime_fork_worktree_path(
        "/target/Wegent_github",
        transfer_id,
    )
    assert response.target.workspace_path == expected_target_path
    assert command_calls == [
        {
            "device_id": "source-device",
            "command_key": "project_folder_status",
            "args": ["/Users/alice/.codex/worktrees/0889/Wegent"],
        },
        {
            "device_id": "target-device",
            "command_key": "project_folder_status",
            "args": ["/target/Wegent_github"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_commit_available",
            "args": ["/target/Wegent_github", "abc123"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_worktree_add",
            "args": ["/target/Wegent_github", expected_target_path, "abc123"],
        },
    ]


@pytest.mark.asyncio
async def test_fork_runtime_task_uses_git_workspace_for_local_path_git_project(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from app.schemas.runtime_work import (
        DeviceWorkspaceUpsert,
        RuntimeTaskAddress,
        RuntimeTaskForkRequest,
    )
    from app.services import runtime_work_service

    project = _local_path_project(
        test_db,
        test_user.id,
        device_id="source-device",
        path="/source/Wegent",
        name="Wegent_github",
    )
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="target-device",
            workspacePath="/target/Wegent_github",
            label="workspace",
        ),
    )
    calls = []
    command_calls = []
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_upload_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used for git workspace forks")
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_download_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used for git workspace forks")
        ),
    )

    command = _git_status_command(
        {
            (
                "source-device",
                "/Users/alice/.codex/worktrees/0889/Wegent",
            ): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "abc123",
            },
            ("target-device", "/target/Wegent_github"): {
                "remoteUrl": "https://github.com/wecode-ai/Wegent.git",
                "headCommit": "def456",
            },
        },
        reachable_commits={("target-device", "/target/Wegent_github", "abc123")},
        calls=command_calls,
    )

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.list":
            return {
                "success": True,
                "workspaces": [
                    {
                        "workspacePath": "/Users/alice/.codex/worktrees/0889/Wegent",
                        "localTasks": [
                            {
                                "localTaskId": "codex-1",
                                "workspacePath": (
                                    "/Users/alice/.codex/worktrees/0889/Wegent"
                                ),
                                "title": "Continue migration",
                                "runtime": "codex",
                                "createdAt": "2026-06-22T00:00:00Z",
                                "updatedAt": "2026-06-22T00:00:00Z",
                            }
                        ],
                    }
                ],
            }
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            assert kwargs["payload"]["workspaceTransfer"] == "git_workspace"
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {
                        "mode": "git_workspace",
                        "transferId": kwargs["payload"]["transferId"],
                    },
                },
            }
        if kwargs["method"] == "runtime.tasks.import_fork":
            expected_target_path = _expected_runtime_fork_worktree_path(
                "/target/Wegent_github",
                calls[1]["payload"]["transferId"],
            )
            assert kwargs["payload"]["workspacePath"] == expected_target_path
            return {
                "success": True,
                "accepted": True,
                "localTaskId": "runtime-copy",
                "workspacePath": kwargs["payload"]["workspacePath"],
                "runtime": "codex",
            }
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)
    monkeypatch.setattr(
        runtime_work_service, "execute_configured_device_command", command
    )

    response = await runtime_work_service.fork_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskForkRequest(
            source=RuntimeTaskAddress(
                deviceId="source-device",
                localTaskId="codex-1",
            ),
            target={
                "deviceId": "target-device",
                "workspacePath": "/target/Wegent_github",
            },
        ),
    )

    assert response.accepted is True
    transfer_id = calls[1]["payload"]["transferId"]
    expected_target_path = _expected_runtime_fork_worktree_path(
        "/target/Wegent_github",
        transfer_id,
    )
    assert response.target.workspace_path == expected_target_path
    assert command_calls == [
        {
            "device_id": "source-device",
            "command_key": "project_folder_status",
            "args": ["/Users/alice/.codex/worktrees/0889/Wegent"],
        },
        {
            "device_id": "target-device",
            "command_key": "project_folder_status",
            "args": ["/target/Wegent_github"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_commit_available",
            "args": ["/target/Wegent_github", "abc123"],
        },
        {
            "device_id": "target-device",
            "command_key": "git_worktree_add",
            "args": ["/target/Wegent_github", expected_target_path, "abc123"],
        },
    ]


@pytest.mark.asyncio
async def test_fork_runtime_task_uses_archive_for_non_git_project_workspace(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from app.schemas.runtime_work import (
        DeviceWorkspaceUpsert,
        RuntimeTaskAddress,
        RuntimeTaskForkRequest,
    )
    from app.services import runtime_work_service

    project = _project(test_db, test_user.id)
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="source-device",
            workspacePath="/source/Wegent",
            label="workspace",
        ),
    )
    runtime_work_service.upsert_device_workspace(
        db=test_db,
        user_id=test_user.id,
        payload=DeviceWorkspaceUpsert(
            projectId=project.id,
            deviceId="target-device",
            workspacePath="/target/Wegent",
            label="workspace",
        ),
    )
    calls = []
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_upload_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("direct transfer should avoid object storage")
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_download_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("direct transfer should avoid object storage")
        ),
    )

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            assert "workspaceTransfer" not in kwargs["payload"]
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {"directUrls": ["http://source/archive"]},
                },
            }
        if (
            kwargs["method"] == "runtime.tasks.import_fork"
            and len(
                [
                    call
                    for call in calls
                    if call["method"] == "runtime.tasks.import_fork"
                ]
            )
            == 1
        ):
            return {"success": False, "error": "direct transfer failed"}
        if kwargs["method"] == "runtime.tasks.prepare_fork_receiver":
            return {
                "success": True,
                "accepted": True,
                "transferId": kwargs["payload"]["transferId"],
                "uploadUrls": ["http://target/upload"],
            }
        if kwargs["method"] == "runtime.tasks.push_fork_transfer":
            return {"success": True, "accepted": True}
        if kwargs["method"] == "runtime.tasks.import_fork":
            return {
                "success": True,
                "accepted": True,
                "localTaskId": "runtime-copy",
                "workspacePath": "/target/Wegent",
                "runtime": "codex",
            }
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.fork_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskForkRequest(
            source=RuntimeTaskAddress(
                deviceId="source-device",
                workspacePath="/source/Wegent",
                localTaskId="codex-1",
            ),
            target={
                "deviceId": "target-device",
                "workspacePath": "/target/Wegent",
            },
        ),
    )

    assert response.accepted is True
    assert [call["method"] for call in calls] == [
        "runtime.tasks.prepare_fork_transfer",
        "runtime.tasks.import_fork",
        "runtime.tasks.prepare_fork_receiver",
        "runtime.tasks.push_fork_transfer",
        "runtime.tasks.import_fork",
    ]


@pytest.mark.asyncio
async def test_fork_runtime_task_uses_bidirectional_direct_transfer(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from app.schemas.runtime_work import RuntimeTaskAddress, RuntimeTaskForkRequest
    from app.services import runtime_work_service

    calls = []
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_upload_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used")
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_download_url",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("object storage should not be used")
        ),
    )

    async def direct_hosts(*, db, user_id, device_id, peer_device_id):
        return {
            "source-device": ["10.0.0.11"],
            "target-device": ["10.0.0.12"],
        }[device_id]

    monkeypatch.setattr(
        runtime_work_service,
        "_runtime_transfer_direct_hosts",
        direct_hosts,
    )

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {"directUrls": ["http://source/archive"]},
                },
            }
        if (
            kwargs["method"] == "runtime.tasks.import_fork"
            and len(
                [
                    call
                    for call in calls
                    if call["method"] == "runtime.tasks.import_fork"
                ]
            )
            == 1
        ):
            return {
                "success": False,
                "error": "direct transfer failed",
                "code": "direct_transfer_unavailable",
            }
        if kwargs["method"] == "runtime.tasks.prepare_fork_receiver":
            return {
                "success": True,
                "accepted": True,
                "transferId": kwargs["payload"]["transferId"],
                "uploadUrls": ["http://target/upload"],
            }
        if kwargs["method"] == "runtime.tasks.push_fork_transfer":
            return {
                "success": True,
                "accepted": True,
                "transferId": kwargs["payload"]["transferId"],
                "uploadedUrl": "http://target/upload",
                "sizeBytes": 123,
            }
        if kwargs["method"] == "runtime.tasks.import_fork":
            return {
                "success": True,
                "accepted": True,
                "localTaskId": "runtime-copy",
                "workspacePath": "/target/Wegent",
                "runtime": "codex",
            }
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    response = await runtime_work_service.fork_runtime_task(
        db=test_db,
        user_id=test_user.id,
        request=RuntimeTaskForkRequest(
            source=RuntimeTaskAddress(
                deviceId="source-device",
                workspacePath="/source/Wegent",
                localTaskId="codex-1",
            ),
            target={
                "deviceId": "target-device",
                "workspacePath": "/target/Wegent",
            },
        ),
    )

    assert response.accepted is True
    assert response.target.local_task_id == "runtime-copy"
    assert [call["method"] for call in calls] == [
        "runtime.tasks.prepare_fork_transfer",
        "runtime.tasks.import_fork",
        "runtime.tasks.prepare_fork_receiver",
        "runtime.tasks.push_fork_transfer",
        "runtime.tasks.import_fork",
    ]
    assert calls[0]["device_id"] == "source-device"
    assert "uploadUrl" not in calls[0]["payload"]
    assert calls[0]["payload"]["directHosts"] == ["10.0.0.11"]
    assert calls[1]["device_id"] == "target-device"
    assert calls[1]["payload"]["forkPackage"]["archive"] == {
        "directUrls": ["http://source/archive"],
    }
    assert calls[2]["device_id"] == "target-device"
    assert calls[2]["payload"]["token"]
    assert calls[2]["payload"]["directHosts"] == ["10.0.0.12"]
    assert calls[3]["device_id"] == "source-device"
    assert calls[3]["payload"]["transferId"] == calls[0]["payload"]["transferId"]
    assert calls[3]["payload"]["uploadUrls"] == ["http://target/upload"]
    assert calls[4]["device_id"] == "target-device"
    assert calls[4]["payload"]["forkPackage"]["archive"] == {
        "directUrls": ["http://source/archive"],
        "localTransferId": calls[2]["payload"]["transferId"],
    }
    assert test_db.query(TaskResource).count() == 0


@pytest.mark.asyncio
async def test_fork_runtime_task_reports_storage_unavailable_without_internal_error(
    test_db,
    test_user,
    monkeypatch,
):
    import copy

    from fastapi import HTTPException, status

    from app.schemas.runtime_work import RuntimeTaskAddress, RuntimeTaskForkRequest
    from app.services import runtime_work_service

    calls = []
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        runtime_work_service,
        "_runtime_transfer_direct_hosts",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        runtime_work_service.object_storage_presign_service,
        "generate_upload_url",
        lambda **kwargs: (_ for _ in ()).throw(
            ValueError("MinIO configuration not set")
        ),
    )

    async def rpc(**kwargs):
        calls.append(copy.deepcopy(kwargs))
        if kwargs["method"] == "runtime.tasks.prepare_fork_transfer":
            return {
                "success": True,
                "package": {
                    "sourceRuntime": "codex",
                    "title": "Continue migration",
                    "archive": {"directUrls": []},
                },
            }
        if kwargs["method"] == "runtime.tasks.import_fork":
            return {"success": False, "error": "direct transfer failed"}
        if kwargs["method"] == "runtime.tasks.prepare_fork_receiver":
            return {
                "success": True,
                "accepted": True,
                "transferId": kwargs["payload"]["transferId"],
                "uploadUrls": [],
            }
        if kwargs["method"] == "runtime.tasks.push_fork_transfer":
            raise AssertionError("push should be skipped without upload URLs")
        raise AssertionError(kwargs["method"])

    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    with pytest.raises(HTTPException) as exc_info:
        await runtime_work_service.fork_runtime_task(
            db=test_db,
            user_id=test_user.id,
            request=RuntimeTaskForkRequest(
                source=RuntimeTaskAddress(
                    deviceId="source-device",
                    workspacePath="/source/Wegent",
                    localTaskId="codex-1",
                ),
                target={
                    "deviceId": "target-device",
                    "workspacePath": "/target/Wegent",
                },
            ),
        )

    assert exc_info.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert [call["method"] for call in calls] == [
        "runtime.tasks.prepare_fork_transfer",
        "runtime.tasks.import_fork",
        "runtime.tasks.prepare_fork_receiver",
    ]


@pytest.mark.asyncio
async def test_runtime_transfer_direct_hosts_uses_reported_host_then_tcp_ip(
    monkeypatch,
):
    from app.services import runtime_work_service

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_online_info",
        AsyncMock(
            return_value={
                "runtime_transfer_host": "192.168.0.190",
                "client_ip": "10.0.0.12",
            }
        ),
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("persisted device IP should not drive direct transfer")
        ),
    )

    assert await runtime_work_service._runtime_transfer_direct_hosts(
        db=None,
        user_id=7,
        device_id="target-device",
        peer_device_id="source-device",
    ) == ["192.168.0.190", "10.0.0.12"]


@pytest.mark.asyncio
async def test_runtime_transfer_direct_hosts_filters_loopback_for_cross_device(
    monkeypatch,
):
    from app.services import runtime_work_service

    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_online_info",
        AsyncMock(
            return_value={
                "runtime_transfer_host": "127.0.0.1",
                "client_ip": "127.0.0.1",
            }
        ),
    )

    assert (
        await runtime_work_service._runtime_transfer_direct_hosts(
            db=None,
            user_id=7,
            device_id="target-device",
            peer_device_id="source-device",
        )
        == []
    )
