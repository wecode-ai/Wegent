# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Claude Code subprocess resource limit preparation."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from shared.status import TaskStatus


class FakeResourceModule:
    """Minimal resource module stub for RLIMIT_NOFILE tests."""

    RLIMIT_NOFILE = object()
    RLIM_INFINITY = -1

    def __init__(self, soft: int, hard: int):
        self.soft = soft
        self.hard = hard
        self.calls = []

    def getrlimit(self, limit):
        assert limit is self.RLIMIT_NOFILE
        return self.soft, self.hard

    def setrlimit(self, limit, values):
        assert limit is self.RLIMIT_NOFILE
        self.calls.append(values)
        self.soft, self.hard = values


def test_ensure_subprocess_nofile_limit_raises_soft_limit_to_hard_cap(monkeypatch):
    """Claude CLI subprocesses should inherit the highest allowed fd limit."""
    from executor.platform_compat import resource_limits

    fake_resource = FakeResourceModule(soft=10240, hard=65536)
    monkeypatch.setattr(resource_limits, "resource", fake_resource)

    result = resource_limits.ensure_subprocess_nofile_limit(minimum=2147483646)

    assert result.changed is True
    assert result.current_soft == 65536
    assert result.current_hard == 65536
    assert fake_resource.calls == [(65536, 65536)]


@pytest.mark.asyncio
async def test_claude_client_prepare_nofile_limit_before_connect(monkeypatch, tmp_path):
    """Claude CLI resource limits must be prepared before SDK connect starts it."""
    from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

    calls = []

    def fake_prepare_limit():
        calls.append("prepare")

    class FakeOptions:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeClient:
        def __init__(self, options=None):
            self.options = options
            self._transport = None

        async def connect(self):
            calls.append("connect")

    class FakeStrategy:
        def configure_client_options(
            self, options, config_dir, env_config, task_identity_env
        ):
            return options

    monkeypatch.setattr(
        "executor.agents.claude_code.claude_code_agent.ensure_subprocess_nofile_limit",
        fake_prepare_limit,
    )
    monkeypatch.setattr(
        "executor.agents.claude_code.claude_code_agent.ClaudeAgentOptions",
        FakeOptions,
    )
    monkeypatch.setattr(
        "executor.agents.claude_code.claude_code_agent.ClaudeSDKClient",
        FakeClient,
    )
    monkeypatch.setattr(
        "executor.agents.claude_code.claude_code_agent.install_deferred_mcp_proxy_hook",
        lambda options: options,
    )

    agent = object.__new__(ClaudeCodeAgent)
    agent.task_id = 123
    agent.subtask_id = 456
    agent.session_id = "session-1"
    agent.options = {"cwd": str(tmp_path)}
    agent._claude_config_dir = ""
    agent._claude_env_config = {}
    agent._mode_strategy = FakeStrategy()
    agent.task_data = SimpleNamespace(device_id=None)
    agent.new_session = False
    agent._bot_id = None
    agent.client = None
    agent.resource_manager = SimpleNamespace(register_resource=MagicMock())
    agent.on_client_created_callback = None
    agent._get_claude_config_dir = MagicMock(return_value=str(tmp_path / ".claude"))
    agent._stderr_callback = MagicMock()
    agent._install_turn_file_change_hooks = MagicMock()
    agent._seed_inherited_session_from_known_empty = MagicMock(return_value=None)

    await agent._create_and_connect_client()

    assert calls == ["prepare", "connect"]


def test_execution_error_reports_captured_claude_stderr():
    """Generic SDK failures should include the captured Claude CLI stderr."""
    from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

    agent = object.__new__(ClaudeCodeAgent)
    agent.task_id = 123
    agent.session_id = "session-1"
    agent.options = {
        "cwd": "/repo",
        "model": "glm-4.6",
        "resume": "saved-session",
        "mcp_servers": {"search": {"type": "http", "url": "https://example.test"}},
    }
    agent.thinking_manager = MagicMock()
    agent.thinking_manager.get_thinking_steps.return_value = []
    agent.add_thinking_step = MagicMock()
    agent.report_progress = MagicMock()

    agent._stderr_callback("error: An unknown error occurred (Unexpected)")
    status = agent._handle_execution_error(
        RuntimeError(
            "Command failed with exit code 1\nError output: Check stderr output for details"
        ),
        "async execution",
    )

    assert status == TaskStatus.FAILED
    thinking_details = agent.add_thinking_step.call_args.kwargs["details"]
    assert thinking_details["claude_cli_stderr"] == (
        "error: An unknown error occurred (Unexpected)"
    )
    assert thinking_details["claude_runtime"]["model"] == "glm-4.6"
    assert thinking_details["claude_runtime"]["resume"] is True
    assert thinking_details["claude_runtime"]["mcp_server_count"] == 1
