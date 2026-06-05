# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local device command RPC service."""

import json
import os
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def test_local_device_command_registry_default_includes_diagnostic_commands():
    """Default command registry should include basic diagnostic commands."""
    from app.core.config import Settings
    from app.services.device.command_registry import resolve_local_device_command

    settings = Settings()

    pwd_definition = resolve_local_device_command("pwd", settings.LOCAL_DEVICE_COMMANDS)
    ls_definition = resolve_local_device_command("ls_a", settings.LOCAL_DEVICE_COMMANDS)
    home_dir_definition = resolve_local_device_command(
        "home_dir", settings.LOCAL_DEVICE_COMMANDS
    )
    project_workspace_root_definition = resolve_local_device_command(
        "project_workspace_root", settings.LOCAL_DEVICE_COMMANDS
    )
    ls_dirs_definition = resolve_local_device_command(
        "ls_dirs", settings.LOCAL_DEVICE_COMMANDS
    )
    mkdir_definition = resolve_local_device_command(
        "mkdir_p", settings.LOCAL_DEVICE_COMMANDS
    )
    path_exists_definition = resolve_local_device_command(
        "path_exists", settings.LOCAL_DEVICE_COMMANDS
    )
    git_clone_definition = resolve_local_device_command(
        "git_clone", settings.LOCAL_DEVICE_COMMANDS
    )
    git_branch_definition = resolve_local_device_command(
        "git_branch", settings.LOCAL_DEVICE_COMMANDS
    )
    git_branch_list_definition = resolve_local_device_command(
        "git_branch_list", settings.LOCAL_DEVICE_COMMANDS
    )
    git_checkout_definition = resolve_local_device_command(
        "git_checkout", settings.LOCAL_DEVICE_COMMANDS
    )
    git_checkout_new_definition = resolve_local_device_command(
        "git_checkout_new", settings.LOCAL_DEVICE_COMMANDS
    )
    git_diff_shortstat_definition = resolve_local_device_command(
        "git_diff_shortstat", settings.LOCAL_DEVICE_COMMANDS
    )
    git_branch_diff_shortstat_definition = resolve_local_device_command(
        "git_branch_diff_shortstat", settings.LOCAL_DEVICE_COMMANDS
    )
    git_remote_url_definition = resolve_local_device_command(
        "git_remote_url", settings.LOCAL_DEVICE_COMMANDS
    )
    git_add_all_definition = resolve_local_device_command(
        "git_add_all", settings.LOCAL_DEVICE_COMMANDS
    )
    git_commit_definition = resolve_local_device_command(
        "git_commit", settings.LOCAL_DEVICE_COMMANDS
    )
    ls_skills_definition = resolve_local_device_command(
        "ls_skills", settings.LOCAL_DEVICE_COMMANDS
    )

    assert pwd_definition is not None
    assert pwd_definition.command == "pwd"
    assert pwd_definition.post_processor is None
    assert ls_definition is not None
    assert ls_definition.command == "ls -a"
    assert ls_definition.post_processor == "file_list"
    assert home_dir_definition is not None
    assert home_dir_definition.command == "printenv HOME"
    assert home_dir_definition.post_processor is None
    assert project_workspace_root_definition is not None
    assert "WEGENT_EXECUTOR_PROJECTS_DIR" in project_workspace_root_definition.command
    assert "WECODE_HOME" in project_workspace_root_definition.command
    assert project_workspace_root_definition.post_processor is None
    assert ls_dirs_definition is not None
    assert ls_dirs_definition.command == "ls -a -p"
    assert ls_dirs_definition.post_processor == "directory_list"
    assert mkdir_definition is not None
    assert mkdir_definition.command == "mkdir -p"
    assert mkdir_definition.post_processor is None
    assert path_exists_definition is not None
    assert path_exists_definition.command == "test -e"
    assert path_exists_definition.post_processor is None
    assert git_clone_definition is not None
    assert git_clone_definition.command == "git clone"
    assert git_clone_definition.post_processor is None
    assert git_branch_definition is not None
    assert git_branch_definition.command == "git branch --show-current"
    assert git_branch_definition.post_processor is None
    assert git_branch_list_definition is not None
    assert git_branch_list_definition.command == "git branch --format=%(refname:short)"
    assert git_branch_list_definition.post_processor is None
    assert git_checkout_definition is not None
    assert git_checkout_definition.command == "git checkout"
    assert git_checkout_definition.post_processor is None
    assert git_checkout_new_definition is not None
    assert git_checkout_new_definition.command == "git checkout -b"
    assert git_checkout_new_definition.post_processor is None
    assert git_diff_shortstat_definition is not None
    assert git_diff_shortstat_definition.command == "git diff --shortstat"
    assert git_diff_shortstat_definition.post_processor is None
    assert git_branch_diff_shortstat_definition is not None
    assert "git merge-base" in git_branch_diff_shortstat_definition.command
    assert "git diff --shortstat" in git_branch_diff_shortstat_definition.command
    assert (
        "git diff --shortstat HEAD --" in git_branch_diff_shortstat_definition.command
    )
    assert git_branch_diff_shortstat_definition.post_processor is None
    assert git_remote_url_definition is not None
    assert git_remote_url_definition.command == "git remote get-url origin"
    assert git_remote_url_definition.post_processor is None
    assert git_add_all_definition is not None
    assert git_add_all_definition.command == "git add --all"
    assert git_add_all_definition.post_processor is None
    assert git_commit_definition is not None
    assert git_commit_definition.command == "git commit"
    assert git_commit_definition.post_processor is None
    assert ls_skills_definition is not None
    assert "python3 -c" in ls_skills_definition.command
    assert ".claude" in ls_skills_definition.command
    assert ".codex" in ls_skills_definition.command
    assert "plugins" in ls_skills_definition.command
    assert ls_skills_definition.post_processor == "json"


def test_local_device_command_registry_supports_inline_post_processor():
    """One command config object should contain command and post processor."""
    from app.services.device.command_registry import resolve_local_device_command

    definition = resolve_local_device_command(
        "repo_files",
        {
            "repo_files": {
                "command": "ls -a",
                "post_processor": "file_list",
            }
        },
    )

    assert definition is not None
    assert definition.command == "ls -a"
    assert definition.post_processor == "file_list"


def test_local_device_command_registry_keeps_default_processor_for_string_override():
    """A simple string override should not drop a built-in post processor."""
    from app.services.device.command_registry import resolve_local_device_command

    definition = resolve_local_device_command("ls_a", {"ls_a": "ls -a"})

    assert definition is not None
    assert definition.command == "ls -a"
    assert definition.post_processor == "file_list"


def test_local_device_command_registry_builds_argv_with_request_args():
    """Command argv should append request args without shell string concatenation."""
    from app.services.device.command_registry import build_local_device_command_argv

    argv = build_local_device_command_argv("ls -a", ["backend", "docs"])

    assert argv == ["ls", "-a", "backend", "docs"]


def test_local_device_command_registry_builds_git_clone_argv():
    """git_clone should support repository URL and target directory args."""
    from app.services.device.command_registry import (
        build_local_device_command_argv,
        resolve_local_device_command,
    )

    definition = resolve_local_device_command("git_clone")

    assert definition is not None
    assert build_local_device_command_argv(
        definition.command,
        ["https://github.com/wecode-ai/Wegent.git", "Wegent"],
    ) == ["git", "clone", "https://github.com/wecode-ai/Wegent.git", "Wegent"]


def test_file_list_post_processor_filters_special_entries():
    """file_list post processor should return a clean file name list."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": ".\n..\n.env\nbackend\n\n",
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "file_list")

    assert processed["stdout"] == [".env", "backend"]


def test_directory_list_post_processor_keeps_only_directories():
    """directory_list post processor should return clean directory names."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": "./\n../\n.env\nbackend/\nfrontend/\nREADME.md\n",
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "directory_list")

    assert processed["stdout"] == ["backend", "frontend"]


def test_json_post_processor_parses_structured_output():
    """json post processor should return parsed command output."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": '[{"name": "env-context", "source": "codex"}]',
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "json")

    assert processed["stdout"] == [{"name": "env-context", "source": "codex"}]


def test_json_post_processor_reports_parse_failure():
    """json post processor should mark malformed JSON results as failed."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": "not-json",
        "stderr": "",
        "duration": 0.01,
    }

    processed = apply_command_post_processor(result, "json")

    assert processed["success"] is False
    assert "Failed to parse command JSON output" in processed["error"]


def test_json_post_processor_reports_truncated_output():
    """json post processor should fail early when stdout was truncated."""
    from app.services.device.command_post_processor import apply_command_post_processor

    result = {
        "success": True,
        "exit_code": 0,
        "stdout": '[{"name": "skill-a", "description": "very long',
        "stderr": "",
        "duration": 0.5,
        "stdout_truncated": True,
    }

    processed = apply_command_post_processor(result, "json")

    assert processed["success"] is False
    assert "truncated" in processed["error"]


def test_ls_skills_command_parses_yaml_block_description(tmp_path):
    """ls_skills should parse YAML block scalars without keeping the marker."""
    from app.services.device.command_registry import LS_SKILLS_SCRIPT

    skill_dir = tmp_path / ".codex" / "skills" / "chronicle"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: chronicle
description: |
  Allows you to view the user's screen as well as several hours of history.

  Use when the user refers to recent work.
metadata:
  short-description: |
    Screen history context.
---

# Chronicle
""",
        encoding="utf-8",
    )

    env = {**os.environ, "HOME": str(tmp_path)}
    result = subprocess.run(
        ["python3", "-c", LS_SKILLS_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    skills = json.loads(result.stdout)

    assert skills == [
        {
            "name": "chronicle",
            "description": (
                "Allows you to view the user's screen as well as several hours "
                "of history. Use when the user refers to recent work."
            ),
            "short_description": "Screen history context.",
            "path": str(skill_dir / "SKILL.md"),
            "source": "codex",
            "origin": "local",
            "mtime": skills[0]["mtime"],
        }
    ]
    assert "|" not in skills[0]["description"]


def test_ls_skills_command_includes_plugin_skills(tmp_path):
    """ls_skills should include skills bundled by installed Claude and Codex plugins."""
    from app.services.device.command_registry import LS_SKILLS_SCRIPT

    claude_skill_dir = (
        tmp_path
        / ".claude"
        / "plugins"
        / "cache"
        / "claude-plugins-official"
        / "superpowers"
        / "5.0.7"
        / "skills"
        / "test-driven-development"
    )
    codex_skill_dir = (
        tmp_path
        / ".codex"
        / "plugins"
        / "cache"
        / "openai-curated"
        / "github"
        / "83d1f0d2"
        / "skills"
        / "github"
    )
    claude_skill_dir.mkdir(parents=True)
    codex_skill_dir.mkdir(parents=True)
    manifest_path = tmp_path / ".wegent-executor" / "capabilities.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(
        json.dumps(
            {
                "version": 1,
                "revision": 1,
                "skills": {},
                "plugins": {
                    "superpowers@claude-plugins-official": {
                        "installed_plugin_id": 9,
                        "managed": True,
                    }
                },
                "mcps": {},
            }
        ),
        encoding="utf-8",
    )
    (claude_skill_dir / "SKILL.md").write_text(
        """---
name: test-driven-development
description: Use when implementing features.
---

# TDD
""",
        encoding="utf-8",
    )
    (codex_skill_dir / "SKILL.md").write_text(
        """---
name: github
description: Inspect repositories and pull requests.
metadata:
  short-description: GitHub workflow support.
---

# GitHub
""",
        encoding="utf-8",
    )

    env = {**os.environ, "HOME": str(tmp_path)}
    result = subprocess.run(
        ["python3", "-c", LS_SKILLS_SCRIPT],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    skills = json.loads(result.stdout)

    assert {
        (
            skill["name"],
            skill["source"],
            skill["origin"],
            skill["plugin_name"],
            skill["path"],
        )
        for skill in skills
    } == {
        (
            "test-driven-development",
            "claude-plugin",
            "wegent",
            "superpowers",
            str(claude_skill_dir / "SKILL.md"),
        ),
        (
            "github",
            "codex-plugin",
            "local",
            "github",
            str(codex_skill_dir / "SKILL.md"),
        ),
    }
    assert (
        next(skill for skill in skills if skill["name"] == "github")[
            "short_description"
        ]
        == "GitHub workflow support."
    )


@pytest.mark.asyncio
async def test_execute_command_calls_registered_device_socket(monkeypatch):
    """Service should send command RPC to the target device socket."""
    from app.services.device import command_service

    mock_sio = AsyncMock()
    mock_sio.call.return_value = {
        "success": True,
        "exit_code": 0,
        "stdout": "ok\n",
        "stderr": "",
        "duration": 0.01,
        "timed_out": False,
    }

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-123"}),
    )
    monkeypatch.setattr(command_service, "get_sio", lambda: mock_sio)

    result = await command_service.local_device_command_service.execute_command(
        user_id=7,
        device_id="device-abc",
        command="pwd",
        path="/tmp",
        args=["-P"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
    )

    assert result["success"] is True
    assert result["stdout"] == "ok\n"
    mock_sio.call.assert_awaited_once_with(
        "device:execute_command",
        {
            "command": "pwd",
            "cwd": "/tmp",
            "args": ["-P"],
            "argv": ["pwd", "-P"],
            "env": {"A": "B"},
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        },
        to="socket-123",
        namespace="/local-executor",
        timeout=10,
    )


@pytest.mark.asyncio
async def test_execute_command_rejects_offline_device(monkeypatch):
    """Service should reject devices without online socket information."""
    from app.services.device import command_service

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info",
        AsyncMock(return_value=None),
    )

    with pytest.raises(command_service.DeviceCommandError) as exc_info:
        await command_service.local_device_command_service.execute_command(
            user_id=7,
            device_id="offline-device",
            command="pwd",
        )

    assert "offline" in str(exc_info.value)


@pytest.mark.asyncio
async def test_execute_configured_device_command_resolves_executes_and_post_processes(
    monkeypatch,
):
    """Internal service API should resolve key, execute command, and post-process."""
    from app.services.device import command_service

    execute_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": ".\n..\nbackend\n",
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: object(),
    )
    monkeypatch.setattr(
        command_service.local_device_command_service,
        "execute_command",
        execute_mock,
    )

    result = await command_service.execute_configured_device_command(
        db=object(),
        user_id=7,
        device_id="device-abc",
        command_key="repo_files",
        path="/tmp",
        args=["backend"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
        command_config={
            "repo_files": {
                "command": "ls -a",
                "post_processor": "file_list",
            }
        },
    )

    assert result["stdout"] == ["backend"]
    execute_mock.assert_awaited_once_with(
        user_id=7,
        device_id="device-abc",
        command="ls -a",
        path="/tmp",
        args=["backend"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
    )


@pytest.mark.asyncio
async def test_execute_configured_device_command_rejects_unowned_device(monkeypatch):
    """Internal service API should reject devices the user does not own."""
    from app.services.device import command_service

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: None,
    )

    with pytest.raises(command_service.DeviceCommandNotFoundError):
        await command_service.execute_configured_device_command(
            db=object(),
            user_id=7,
            device_id="device-abc",
            command_key="pwd",
        )


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_maps_request_to_service(monkeypatch):
    """Endpoint should delegate HTTP request data to the internal service API."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": "ok",
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)
    db = object()

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(
            command_key="repo_status",
            path="/tmp",
            args=["--short"],
            env={"A": "B"},
            timeout_seconds=5,
            max_output_bytes=1024,
        ),
        db=db,
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    assert response.stdout == "ok"
    service_mock.assert_awaited_once_with(
        db=db,
        user_id=7,
        device_id="device-abc",
        command_key="repo_status",
        path="/tmp",
        args=["--short"],
        env={"A": "B"},
        timeout_seconds=5,
        max_output_bytes=1024,
    )


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_applies_configured_post_processor(
    monkeypatch,
):
    """Endpoint should return post-processed internal service results."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": [".env", "backend"],
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(command_key="repo_files"),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    assert response.stdout == [".env", "backend"]


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_returns_structured_stdout(monkeypatch):
    """Endpoint should allow command processors to return object lists."""
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    skills = [
        {
            "name": "env-context",
            "description": "Environment facts.",
            "short_description": "Environment facts.",
            "path": "/Users/crystal/.codex/skills/env-context/SKILL.md",
            "source": "codex",
            "mtime": 1780462034.0,
        }
    ]
    service_mock = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": skills,
            "stderr": "",
            "duration": 0.02,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(devices, "execute_configured_device_command", service_mock)

    response = await devices.execute_device_command(
        device_id="device-abc",
        request=DeviceCommandRequest(command_key="ls_skills"),
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    assert response.stdout == skills


@pytest.mark.asyncio
async def test_execute_device_command_endpoint_rejects_unknown_command_key(monkeypatch):
    """Endpoint should reject command keys missing from backend configuration."""
    from fastapi import HTTPException

    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest

    async def raise_unknown_key(**kwargs):
        raise devices.DeviceCommandUnknownKeyError(
            "Device command key 'repo_status' is not configured"
        )

    monkeypatch.setattr(devices, "execute_configured_device_command", raise_unknown_key)

    with pytest.raises(HTTPException) as exc_info:
        await devices.execute_device_command(
            device_id="device-abc",
            request=DeviceCommandRequest(command_key="repo_status"),
            db=object(),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 400
    assert "not configured" in exc_info.value.detail
