# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Architecture boundary tests for interactive form MCP execution."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_claude_code_executor_does_not_implement_interactive_form_tool():
    """Claude Code defer may proxy MCP, but must not implement form rendering."""
    assert not (
        REPO_ROOT / "executor" / "agents" / "claude_code" / "deferred_input.py"
    ).exists()

    agent_source = (
        REPO_ROOT / "executor" / "agents" / "claude_code" / "claude_code_agent.py"
    ).read_text(encoding="utf-8")
    response_processor_source = (
        REPO_ROOT / "executor" / "agents" / "claude_code" / "response_processor.py"
    ).read_text(encoding="utf-8")
    proxy_source = (
        REPO_ROOT / "executor" / "agents" / "claude_code" / "deferred_mcp_proxy.py"
    ).read_text(encoding="utf-8")

    assert "install_deferred_input_hook" not in agent_source
    assert "build_interactive_form_render_payload" not in response_processor_source
    assert "build_interactive_form_render_payload" not in proxy_source
    assert "RenderedInteractiveForm" not in proxy_source
