# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

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
