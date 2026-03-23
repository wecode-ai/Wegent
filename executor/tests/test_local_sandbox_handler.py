# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for lightweight device sandbox command handling."""

import subprocess
from unittest.mock import MagicMock, patch

from executor.modes.local.handlers import SandboxHandler


class TestSandboxHandler:
    """Tests for SandboxHandler."""

    def test_execute_command_sync_returns_process_output(self):
        """Successful subprocess output should be returned unchanged."""
        handler = SandboxHandler(runner=MagicMock())

        completed = subprocess.CompletedProcess(
            args=["echo", "hello"],
            returncode=0,
            stdout="hello\n",
            stderr="",
        )

        with patch(
            "executor.modes.local.handlers.subprocess.run", return_value=completed
        ):
            result = handler._execute_command_sync(
                command="echo hello",
                working_dir="/tmp",
                timeout_seconds=5,
            )

        assert result["success"] is True
        assert result["stdout"] == "hello\n"
        assert result["stderr"] == ""
        assert result["exit_code"] == 0

    def test_execute_command_sync_returns_timeout_error(self):
        """Timeouts should surface as structured command failures."""
        handler = SandboxHandler(runner=MagicMock())

        with patch(
            "executor.modes.local.handlers.subprocess.run",
            side_effect=subprocess.TimeoutExpired(
                cmd="sleep 10",
                timeout=1,
                output="partial",
                stderr="still running",
            ),
        ):
            result = handler._execute_command_sync(
                command="sleep 10",
                working_dir="/tmp",
                timeout_seconds=1,
            )

        assert result["success"] is False
        assert result["stdout"] == "partial"
        assert "timed out" in result["stderr"]
        assert result["exit_code"] == -1
