# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.task import TaskResource
from app.services import project_service


def test_build_git_clone_args_includes_branch_and_single_branch():
    args = project_service._build_git_clone_args(
        "https://github.com/wecode-ai/Wegent.git",
        "develop",
        "Wegent",
    )

    assert args == [
        "--branch",
        "develop",
        "--single-branch",
        "https://github.com/wecode-ai/Wegent.git",
        "Wegent",
    ]


def test_default_git_project_name_removes_git_suffix():
    assert (
        project_service._default_git_project_name(
            None, "https://github.com/wecode-ai/Wegent.git"
        )
        == "Wegent"
    )


def test_target_path_exists_error_message():
    error = project_service._target_path_exists_error("/workspace/projects/Wegent")

    assert error.status_code == 409
    assert "already exists" in error.detail
    assert "/workspace/projects/Wegent" in error.detail


def test_build_git_worktree_path_uses_task_id_and_project_directory_name():
    path = project_service._build_git_worktree_path("d837/Wegent", "1386")

    assert path == "worktrees/1386/Wegent"


def test_resolve_source_checkout_abs_path_uses_project_workspace_root():
    assert (
        project_service._resolve_source_workspace_abs_path(
            "/workspace/projects",
            "d837/Wegent",
        )
        == "/workspace/projects/d837/Wegent"
    )
    assert (
        project_service._resolve_source_workspace_abs_path(
            "/workspace/projects",
            "projects/d837/Wegent",
        )
        == "/workspace/projects/d837/Wegent"
    )


def test_project_task_list_includes_device_and_execution_workspace_source(
    test_db, test_user
):
    project = Project(
        user_id=test_user.id,
        name="Wegent",
        client_origin="wework",
        config={"mode": "workspace"},
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)

    task = TaskResource(
        id=1386,
        user_id=test_user.id,
        kind="Task",
        name="task-1386",
        namespace="default",
        project_id=project.id,
        client_origin="wework",
        is_active=TaskResource.STATE_ACTIVE,
        json={
            "kind": "Task",
            "spec": {
                "title": "Worktree chat",
                "device_id": "device-1",
                "execution": {
                    "workspace": {
                        "source": "git_worktree",
                        "path": "/workspace/worktrees/1386/Wegent",
                    }
                },
            },
            "status": {"phase": "COMPLETED"},
        },
    )
    test_db.add(task)
    test_db.commit()

    items = project_service._get_project_tasks(
        test_db, project.id, client_origin="wework"
    )

    assert len(items) == 1
    assert items[0].device_id == "device-1"
    assert items[0].execution_workspace_source == "git_worktree"


@pytest.mark.asyncio
async def test_prepare_git_checkout_stops_when_target_path_exists():
    command_mock = AsyncMock(
        side_effect=[
            {"success": True, "exit_code": 0, "stdout": "/workspace/projects"},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
        ]
    )

    with patch(
        "app.services.project_service.execute_configured_device_command",
        command_mock,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await project_service._prepare_git_checkout(
                db=object(),
                user_id=7,
                device_id="device-1",
                git_url="https://github.com/wecode-ai/Wegent.git",
                branch="main",
                checkout_path="Wegent",
            )

    assert exc_info.value.status_code == 409
    assert "/workspace/projects/Wegent" in exc_info.value.detail
    assert [call.kwargs["command_key"] for call in command_mock.await_args_list] == [
        "project_workspace_root",
        "mkdir_p",
        "path_exists",
    ]


@pytest.mark.asyncio
async def test_prepare_git_worktree_for_task_creates_worktree(test_db, test_user):
    project = Project(
        user_id=test_user.id,
        name="Wegent",
        client_origin="wework",
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {"source": "git", "checkoutPath": "d837/Wegent"},
            "git": {"url": "https://github.com/wecode-ai/Wegent.git"},
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    command_mock = AsyncMock(
        side_effect=[
            {"success": True, "exit_code": 0, "stdout": "/workspace/projects"},
            {"success": True, "exit_code": 0, "stdout": "true\n", "stderr": ""},
            {"success": False, "exit_code": 1, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
        ]
    )

    with patch(
        "app.services.project_service.execute_configured_device_command",
        command_mock,
    ):
        result = await project_service.prepare_git_worktree_for_task(
            db=test_db,
            user_id=test_user.id,
            project_id=project.id,
            client_origin="wework",
            task_id=1386,
        )

    assert result == {
        "source": "git_worktree",
        "path": "/workspace/worktrees/1386/Wegent",
    }
    assert [call.kwargs["command_key"] for call in command_mock.await_args_list] == [
        "project_workspace_root",
        "git_is_worktree",
        "path_exists",
        "mkdir_p",
        "git_worktree_add",
    ]
    assert command_mock.await_args_list[-1].kwargs["args"] == [
        "/workspace/projects/d837/Wegent",
        "/workspace/worktrees/1386/Wegent",
    ]


@pytest.mark.asyncio
async def test_prepare_git_worktree_for_task_supports_existing_local_path_project(
    test_db, test_user
):
    project = Project(
        user_id=test_user.id,
        name="Manual Wegent",
        client_origin="wework",
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {
                "source": "local_path",
                "localPath": "/workspace/manual/Wegent",
            },
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    command_mock = AsyncMock(
        side_effect=[
            {"success": True, "exit_code": 0, "stdout": "/workspace/projects"},
            {"success": True, "exit_code": 0, "stdout": "true\n", "stderr": ""},
            {"success": False, "exit_code": 1, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
        ]
    )

    with patch(
        "app.services.project_service.execute_configured_device_command",
        command_mock,
    ):
        result = await project_service.prepare_git_worktree_for_task(
            db=test_db,
            user_id=test_user.id,
            project_id=project.id,
            client_origin="wework",
            task_id=1387,
        )

    assert result == {
        "source": "git_worktree",
        "path": "/workspace/worktrees/1387/Wegent",
    }
    assert command_mock.await_args_list[1].kwargs["args"] == [
        "/workspace/manual/Wegent"
    ]
    assert command_mock.await_args_list[-1].kwargs["args"] == [
        "/workspace/manual/Wegent",
        "/workspace/worktrees/1387/Wegent",
    ]


@pytest.mark.asyncio
async def test_prepare_git_worktree_for_task_supports_legacy_device_id_config(
    test_db, test_user
):
    project = Project(
        user_id=test_user.id,
        name="Legacy Wegent",
        client_origin="wework",
        config={
            "mode": "workspace",
            "device_id": "device-1",
            "workspace": {
                "source": "local_path",
                "localPath": "/workspace/manual/Wegent",
            },
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    command_mock = AsyncMock(
        side_effect=[
            {"success": True, "exit_code": 0, "stdout": "/workspace/projects"},
            {"success": True, "exit_code": 0, "stdout": "true\n", "stderr": ""},
            {"success": False, "exit_code": 1, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
        ]
    )

    with patch(
        "app.services.project_service.execute_configured_device_command",
        command_mock,
    ):
        result = await project_service.prepare_git_worktree_for_task(
            db=test_db,
            user_id=test_user.id,
            project_id=project.id,
            client_origin="wework",
            task_id=1388,
        )

    assert result == {
        "source": "git_worktree",
        "path": "/workspace/worktrees/1388/Wegent",
    }
    assert command_mock.await_args_list[0].kwargs["device_id"] == "device-1"
    assert command_mock.await_args_list[-1].kwargs["args"] == [
        "/workspace/manual/Wegent",
        "/workspace/worktrees/1388/Wegent",
    ]


@pytest.mark.asyncio
async def test_prepare_git_worktree_for_task_rejects_non_git_directory(
    test_db, test_user
):
    project = Project(
        user_id=test_user.id,
        name="Notes",
        client_origin="wework",
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {"source": "local_path", "localPath": "/workspace/notes"},
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    command_mock = AsyncMock(
        side_effect=[
            {"success": True, "exit_code": 0, "stdout": "/workspace/projects"},
            {
                "success": False,
                "exit_code": 128,
                "stdout": "",
                "stderr": "fatal: not a git repository",
            },
        ]
    )

    with patch(
        "app.services.project_service.execute_configured_device_command",
        command_mock,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await project_service.prepare_git_worktree_for_task(
                db=test_db,
                user_id=test_user.id,
                project_id=project.id,
                client_origin="wework",
                task_id=1389,
            )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Project directory is not a Git repository"
    assert [call.kwargs["command_key"] for call in command_mock.await_args_list] == [
        "project_workspace_root",
        "git_is_worktree",
    ]


@pytest.mark.asyncio
async def test_list_project_worktrees_scans_each_online_project_device_once(
    test_db, test_user
):
    project = Project(
        user_id=test_user.id,
        name="Wegent",
        client_origin="wework",
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {"source": "git", "checkoutPath": "d837/Wegent"},
            "git": {"url": "https://github.com/wecode-ai/Wegent.git"},
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    task = TaskResource(
        id=1386,
        user_id=test_user.id,
        kind="Task",
        name="task-worktree",
        namespace="default",
        project_id=project.id,
        client_origin="wework",
        json={
            "spec": {
                "title": "Fix sidebar persistence",
                "execution": {
                    "workspace": {
                        "source": "git_worktree",
                        "path": "/workspace/worktrees/1386/Wegent",
                    }
                },
            },
            "status": {"phase": "RUNNING"},
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    test_db.add(task)
    test_db.commit()
    command_mock = AsyncMock(
        side_effect=[
            {"success": True, "exit_code": 0, "stdout": "/workspace/projects"},
            {
                "success": True,
                "exit_code": 0,
                "stdout": [
                    "/workspace/worktrees/1386/Wegent",
                    "/workspace/worktrees/1390/Wegent",
                    "/workspace/worktrees/git/hello-git-work-tree-9b4f2ef3",
                    "/workspace/worktrees/82e3/Wegent",
                    "/workspace/worktrees/1387/Unknown",
                    "/workspace/worktrees/zzzz/Wegent",
                ],
                "stderr": "",
            },
        ]
    )

    with (
        patch(
            "app.services.project_service.device_service.get_all_devices",
            AsyncMock(
                return_value=[
                    {
                        "device_id": "device-1",
                        "name": "Crystal Mac",
                        "status": "online",
                    }
                ]
            ),
        ),
        patch(
            "app.services.project_service.execute_configured_device_command",
            command_mock,
        ),
    ):
        result = await project_service.list_project_worktrees(
            db=test_db,
            user_id=test_user.id,
            client_origin="wework",
        )

    assert result.total == 2
    assert len(result.devices) == 1
    assert result.devices[0].device_name == "Crystal Mac"
    assert result.devices[0].available is True
    assert result.devices[0].items[0].worktree_id == "1386"
    assert result.devices[0].items[0].project_name == "Wegent"
    assert result.devices[0].items[0].path == "/workspace/worktrees/1386/Wegent"
    assert result.devices[0].items[0].project is not None
    assert result.devices[0].items[0].project.id == project.id
    assert result.devices[0].items[0].task is not None
    assert result.devices[0].items[0].task.id == task.id
    assert result.devices[0].items[0].task.title == "Fix sidebar persistence"
    assert result.devices[0].items[0].task.status == "RUNNING"
    assert result.devices[0].items[0].task.project_id == project.id
    assert result.devices[0].items[1].worktree_id == "1390"
    assert result.devices[0].items[1].task is None
    assert [call.kwargs["command_key"] for call in command_mock.await_args_list] == [
        "project_workspace_root",
        "find_worktree_dirs",
    ]
    assert command_mock.await_args_list[-1].kwargs["args"] == ["/workspace/worktrees"]


@pytest.mark.asyncio
async def test_delete_project_worktree_removes_directory_and_matching_task(
    test_db, test_user
):
    project = Project(
        user_id=test_user.id,
        name="Wegent",
        client_origin="wework",
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {"source": "git", "checkoutPath": "d837/Wegent"},
            "git": {"url": "https://github.com/wecode-ai/Wegent.git"},
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    task = TaskResource(
        id=1386,
        user_id=test_user.id,
        kind="Task",
        name="task-worktree",
        namespace="default",
        project_id=project.id,
        client_origin="wework",
        json={
            "spec": {
                "execution": {
                    "workspace": {
                        "source": "git_worktree",
                    }
                }
            }
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    command_mock = AsyncMock(
        side_effect=[
            {"success": True, "exit_code": 0, "stdout": "/workspace/projects"},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
            {"success": True, "exit_code": 0, "stdout": "", "stderr": ""},
        ]
    )
    delete_task_mock = Mock()

    with (
        patch(
            "app.services.project_service.execute_configured_device_command",
            command_mock,
        ),
        patch(
            "app.services.project_service.task_kinds_service.delete_task",
            delete_task_mock,
        ),
    ):
        result = await project_service.delete_project_worktree(
            db=test_db,
            user_id=test_user.id,
            client_origin="wework",
            device_id="device-1",
            worktree_id="1386",
            project_id=project.id,
        )

    assert result.worktree_id == "1386"
    assert result.path == "/workspace/worktrees/1386/Wegent"
    assert result.deleted_task_ids == [task.id]
    assert [call.kwargs["command_key"] for call in command_mock.await_args_list] == [
        "project_workspace_root",
        "path_exists",
        "git_worktree_remove",
        "remove_worktree_dir",
    ]
    assert command_mock.await_args_list[2].kwargs["args"] == [
        "/workspace/projects/d837/Wegent",
        "/workspace/worktrees/1386/Wegent",
    ]
    assert command_mock.await_args_list[3].kwargs["args"] == [
        "/workspace/worktrees/1386/Wegent"
    ]
    delete_task_mock.assert_called_once_with(
        db=test_db,
        task_id=task.id,
        user_id=test_user.id,
        client_origin="wework",
    )


@pytest.mark.asyncio
async def test_delete_project_worktree_rejects_legacy_worktree_id(test_db, test_user):
    project = Project(
        user_id=test_user.id,
        name="Wegent",
        client_origin="wework",
        config={
            "mode": "workspace",
            "execution": {"targetType": "local", "deviceId": "device-1"},
            "workspace": {"source": "git", "checkoutPath": "d837/Wegent"},
            "git": {"url": "https://github.com/wecode-ai/Wegent.git"},
        },
        is_active=True,
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    command_mock = AsyncMock()

    with patch(
        "app.services.project_service.execute_configured_device_command",
        command_mock,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await project_service.delete_project_worktree(
                db=test_db,
                user_id=test_user.id,
                client_origin="wework",
                device_id="device-1",
                worktree_id="git",
                project_id=project.id,
            )

    assert exc_info.value.status_code == 404
    assert command_mock.await_count == 0
