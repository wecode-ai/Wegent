# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local executor command RPC handling."""

import pytest


def test_build_env_removes_pyinstaller_runtime_variables(monkeypatch):
    """Command subprocess env should not inherit PyInstaller runtime variables."""
    from executor.modes.local.command_handler import CommandHandler

    monkeypatch.setenv("_PYI_ARCHIVE_FILE", "/tmp/wegent-executor")
    monkeypatch.setenv("_PYI_PARENT_PROCESS_LEVEL", "0")
    monkeypatch.setenv("_PYI_APPLICATION_HOME_DIR", "/tmp/_MEI123")
    monkeypatch.setenv("_MEIPASS", "/tmp/_MEI456")
    monkeypatch.setenv("_MEI_CUSTOM", "/tmp/_MEI789")
    monkeypatch.setenv("WECODE_HOME", "/tmp/wecode")

    handler = CommandHandler()

    env = handler._build_env(
        {
            "EXTRA_ENV": "ok",
            "NULL_ENV": None,
            "_PYI_EXTRA": "bad",
            "_MEI_EXTRA": "bad",
        }
    )

    assert "WECODE_HOME" in env
    assert env["EXTRA_ENV"] == "ok"
    assert env["NULL_ENV"] == ""
    assert all(not key.startswith(("_PYI_", "_MEI_")) for key in env)
    assert "_MEIPASS" not in env


@pytest.mark.asyncio
async def test_execute_command_uses_argv_and_cwd(tmp_path):
    """Command handler should execute argv args in the requested working directory."""
    from executor.modes.local.command_handler import CommandHandler

    target = tmp_path / "target.txt"
    target.write_text("ok", encoding="utf-8")
    handler = CommandHandler()

    result = await handler.handle_execute_command(
        {
            "command": "cat",
            "argv": ["cat", "target.txt"],
            "cwd": str(tmp_path),
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        }
    )

    assert result["success"] is True
    assert result["stdout"] == "ok"


@pytest.mark.asyncio
async def test_execute_command_argv_does_not_invoke_shell():
    """Command argv args should not be interpreted by a shell."""
    from executor.modes.local.command_handler import CommandHandler

    handler = CommandHandler()

    result = await handler.handle_execute_command(
        {
            "command": "printf %s",
            "argv": ["printf", "%s", "hello; echo hacked"],
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        }
    )

    assert result["success"] is True
    assert result["stdout"] == "hello; echo hacked"


@pytest.mark.asyncio
async def test_execute_command_returns_completed_process_result():
    """Command handler should return stdout, stderr, exit code, and duration."""
    from executor.modes.local.command_handler import CommandHandler

    handler = CommandHandler()

    result = await handler.handle_execute_command(
        {
            "command": "printf 'hello'",
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        }
    )

    assert result["success"] is True
    assert result["exit_code"] == 0
    assert result["stdout"] == "hello"
    assert result["stderr"] == ""
    assert result["duration"] >= 0
    assert result["timed_out"] is False


@pytest.mark.asyncio
async def test_execute_command_times_out_and_returns_error():
    """Command handler should kill long commands and return a timeout result."""
    from executor.modes.local.command_handler import CommandHandler

    handler = CommandHandler()

    result = await handler.handle_execute_command(
        {
            "command": "sleep 2",
            "timeout_seconds": 0.1,
            "max_output_bytes": 1024,
        }
    )

    assert result["success"] is False
    assert result["exit_code"] is None
    assert result["timed_out"] is True
    assert "timed out" in result["error"].lower()


@pytest.mark.asyncio
async def test_execute_command_missing_cwd_returns_error_without_exception_log(
    tmp_path, monkeypatch
):
    """Missing worktrees should return a normal error without traceback logging."""
    from executor.modes.local import command_handler
    from executor.modes.local.command_handler import CommandHandler

    missing_cwd = tmp_path / "deleted-worktree"
    logger_calls = []

    class FakeLogger:
        def info(self, *args, **kwargs):
            logger_calls.append(("info", args, kwargs))

        def warning(self, *args, **kwargs):
            logger_calls.append(("warning", args, kwargs))

        def exception(self, *args, **kwargs):
            logger_calls.append(("exception", args, kwargs))

    monkeypatch.setattr(command_handler, "logger", FakeLogger())

    result = await CommandHandler().handle_execute_command(
        {
            "command": "pwd",
            "cwd": str(missing_cwd),
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        }
    )

    assert result["success"] is False
    assert result["exit_code"] is None
    assert "Working directory does not exist" in result["error"]
    assert str(missing_cwd) in result["error"]
    assert not any(level == "exception" for level, _, _ in logger_calls)
