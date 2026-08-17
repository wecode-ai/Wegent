# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for safe Claude CLI command construction."""

import shlex

from init_data.skills.sandbox.claude_tool import _build_claude_command


def test_build_claude_command_shell_quotes_untrusted_arguments():
    prompt = (
        "Create `/home/user/test.py`; keep $(whoami) and `**main**` literal.\nDone."
    )
    allowed_tools = "Write,Bash(*)"
    system_prompt = 'Keep "quotes", $HOME, and newlines\nliteral.'

    command = _build_claude_command(prompt, allowed_tools, system_prompt)

    expected_args = [
        "claude",
        "-p",
        prompt,
        "--allowedTools",
        allowed_tools,
        "--append-system-prompt",
        system_prompt,
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    assert command == shlex.join(expected_args)
    assert shlex.quote(prompt) in command
    assert shlex.quote(system_prompt) in command
