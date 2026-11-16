# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Git RPC diagnostics retain failure evidence without recording credentials."""

import logging
from unittest.mock import AsyncMock

import pytest

from app.services.device import command_service


@pytest.mark.parametrize(
    ("stderr", "category"),
    [
        (
            "fatal: destination path 'repo' already exists and is not an empty directory.",
            "target_not_empty",
        ),
        (
            "fatal: could not read Username for 'https://git.example': No such device",
            "authentication",
        ),
        ("Permission denied (publickey).", "authentication"),
        (
            "fatal: Authentication failed for 'https://git.example/repo.git'",
            "authentication",
        ),
        ("fatal: repository not found", "repository_not_found"),
        ("Remote branch feature not found in upstream origin", "branch_not_found"),
        ("Host key verification failed.", "host_key"),
        ("fatal: unable to access URL: Could not resolve host", "network"),
        ("fatal: not a git repository", "not_repository"),
        (
            "fatal: could not create work tree dir: Permission denied",
            "path_permissions",
        ),
        ("No such file or directory", "path_missing"),
        ("an unknown Git error", "git_error"),
    ],
)
def test_git_failure_categories_do_not_need_raw_output(stderr, category):
    assert (
        command_service._git_command_failure(
            {"success": False, "exit_code": 128, "stderr": stderr}
        )
        == category
    )


def test_git_timeout_and_success_categories():
    assert command_service._git_command_failure({"timed_out": True}) == "timeout"
    assert (
        command_service._git_command_failure({"success": True, "exit_code": 0})
        == "none"
    )


@pytest.mark.asyncio
async def test_clone_rpc_logs_target_and_category_but_preserves_response(
    monkeypatch, caplog
):
    secret = "secret-value-must-not-be-logged"
    result = {
        "success": False,
        "exit_code": 128,
        "stderr": f"fatal: Authentication failed for https://alice:{secret}@git.example/repo",
        "stdout": secret,
        "duration": 0.125,
    }
    sio = AsyncMock()
    sio.call.return_value = result
    monkeypatch.setattr(command_service, "get_sio", lambda: sio)
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-device"}),
    )
    with caplog.at_level(logging.INFO, logger=command_service.__name__):
        actual = await command_service.local_device_command_service.execute_command(
            user_id=7,
            device_id="device-remote",
            command="git clone",
            args=[f"https://alice:{secret}@git.example/repo", "/home/wegent/repo"],
            env={"GIT_TOKEN": secret},
        )
    assert actual is result
    assert "target='/home/wegent/repo'" in caplog.text
    assert "device_id=device-remote" in caplog.text
    assert "exit_code=128" in caplog.text
    assert "failure=authentication" in caplog.text
    assert secret not in caplog.text
    assert "alice" not in caplog.text


@pytest.mark.parametrize(
    "value", ["https://alice:secret@git.example/repo", "git@git.example:repo", None]
)
def test_command_operands_are_not_logged_as_paths(value):
    assert command_service._command_log_path(value) is None


@pytest.mark.parametrize("path", ["/home/wegent/repo", r"C:\Users\alice\repo"])
def test_absolute_target_paths_are_loggable(path):
    assert command_service._command_log_path(path) == path
