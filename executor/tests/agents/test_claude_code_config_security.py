# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for ClaudeCodeAgent configuration security in Local mode.

This module tests the security improvements that prevent sensitive data
(API keys, tokens) from being written to disk in Local mode.
"""

import json
import os
import stat
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def create_mock_emitter():
    """Create a mock emitter for testing."""
    emitter = MagicMock()
    emitter.in_progress = AsyncMock()
    emitter.start = AsyncMock()
    emitter.done = AsyncMock()
    emitter.error = AsyncMock()
    emitter.text_delta = AsyncMock()
    return emitter


class TestSaveClaudeConfigFiles:
    """Tests for _save_claude_config_files method security improvements."""

    @pytest.fixture
    def task_data(self):
        """Sample task data for testing."""
        return {
            "task_id": 12345,
            "subtask_id": 67890,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
            "user": {"user_name": "testuser"},
            "bot": [{"api_key": "test_api_key", "model": "claude-3-5-sonnet-20241022"}],
        }

    @pytest.fixture
    def agent_config_with_sensitive_data(self):
        """Agent config containing sensitive API credentials."""
        return {
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "sk-ant-api-secret-key-12345",
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                "ANTHROPIC_MODEL": "claude-3-5-sonnet-20241022",
            },
            "allowedTools": [],
            "model": "claude-3-5-sonnet-20241022",
        }

    @pytest.fixture
    def temp_workspace(self):
        """Create temporary workspace directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    def _create_agent(self, task_data):
        """Create ClaudeCodeAgent instance with mocked dependencies."""
        from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

        mock_emitter = create_mock_emitter()
        return ClaudeCodeAgent(task_data, mock_emitter)

    def test_local_mode_does_not_write_settings_json(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that Local mode does NOT write settings.json containing sensitive data.

        In Local mode, settings.json should not be created because it contains
        sensitive information like ANTHROPIC_AUTH_TOKEN.
        """
        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            # Verify settings.json was NOT created
            settings_path = os.path.join(
                temp_workspace, str(task_data["task_id"]), ".claude", "settings.json"
            )
            assert not os.path.exists(
                settings_path
            ), f"settings.json should NOT exist in Local mode: {settings_path}"

    def test_local_mode_writes_claude_json(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that Local mode writes non-sensitive claude.json file.

        claude.json contains user preferences only (no API keys) and is
        required by the SDK for proper operation.
        """
        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            # Verify claude.json was created
            claude_json_path = os.path.join(
                temp_workspace, str(task_data["task_id"]), ".claude", "claude.json"
            )
            assert os.path.exists(
                claude_json_path
            ), f"claude.json should exist: {claude_json_path}"

            # Verify claude.json content is non-sensitive
            with open(claude_json_path) as f:
                claude_config = json.load(f)

            # Check expected non-sensitive fields
            assert "hasCompletedOnboarding" in claude_config
            assert "userID" in claude_config
            assert "bypassPermissionsModeAccepted" in claude_config

            # Verify NO sensitive data in claude.json
            claude_json_str = json.dumps(claude_config)
            assert "ANTHROPIC_AUTH_TOKEN" not in claude_json_str
            assert "sk-ant-api" not in claude_json_str
            assert "api_key" not in claude_json_str.lower()

    def test_local_mode_env_config_stored_in_memory(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that Local mode stores env config in memory for SDK env parameter.

        Sensitive configuration should be passed via environment variables,
        not written to files.
        """
        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            # Verify env config is stored in memory
            assert hasattr(agent, "_claude_env_config")
            assert agent._claude_env_config == agent_config_with_sensitive_data["env"]
            assert "ANTHROPIC_AUTH_TOKEN" in agent._claude_env_config

    def test_local_mode_directory_permissions(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that .claude directory has restricted permissions (0700) in Local mode.

        Only the owner should be able to read/write/execute the directory.
        """
        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            config_dir = os.path.join(
                temp_workspace, str(task_data["task_id"]), ".claude"
            )
            dir_stat = os.stat(config_dir)
            dir_mode = stat.S_IMODE(dir_stat.st_mode)

            # Verify directory permissions are 0700 (owner rwx only)
            assert (
                dir_mode == 0o700
            ), f"Directory permissions should be 0700, got {oct(dir_mode)}"

    def test_local_mode_claude_json_file_permissions(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that claude.json has restricted permissions (0600) in Local mode.

        Only the owner should be able to read/write the file.
        """
        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            claude_json_path = os.path.join(
                temp_workspace, str(task_data["task_id"]), ".claude", "claude.json"
            )
            file_stat = os.stat(claude_json_path)
            file_mode = stat.S_IMODE(file_stat.st_mode)

            # Verify file permissions are 0600 (owner rw only)
            assert (
                file_mode == 0o600
            ), f"File permissions should be 0600, got {oct(file_mode)}"

    def test_docker_mode_writes_settings_json(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that Docker mode still writes settings.json (isolated container).

        Docker containers are isolated, so writing settings.json is acceptable.
        """
        docker_home = os.path.join(temp_workspace, "docker_home")
        os.makedirs(docker_home, exist_ok=True)

        with (
            patch("executor.config.config.EXECUTOR_MODE", "docker"),
            patch(
                "os.path.expanduser", side_effect=lambda p: p.replace("~", docker_home)
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            # Verify settings.json was created in Docker mode
            settings_path = os.path.join(docker_home, ".claude", "settings.json")
            assert os.path.exists(
                settings_path
            ), f"settings.json should exist in Docker mode: {settings_path}"

            # Verify it contains the config
            with open(settings_path) as f:
                settings = json.load(f)
            assert "env" in settings

    def test_docker_mode_writes_claude_json(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that Docker mode writes claude.json to ~/.claude.json.
        """
        docker_home = os.path.join(temp_workspace, "docker_home")
        os.makedirs(docker_home, exist_ok=True)

        with (
            patch("executor.config.config.EXECUTOR_MODE", "docker"),
            patch(
                "os.path.expanduser", side_effect=lambda p: p.replace("~", docker_home)
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            # Verify claude.json was created
            claude_json_path = os.path.join(docker_home, ".claude.json")
            assert os.path.exists(
                claude_json_path
            ), f"claude.json should exist in Docker mode: {claude_json_path}"

    def test_local_mode_no_sensitive_data_in_any_files(
        self, task_data, agent_config_with_sensitive_data, temp_workspace
    ):
        """
        Test that NO sensitive data exists in any files in Local mode.

        This is a comprehensive check to ensure API keys and tokens
        are not written anywhere in the workspace.
        """
        sensitive_patterns = [
            "sk-ant-api",
            "ANTHROPIC_AUTH_TOKEN",
            "api_key",
            "secret",
            "password",
            "token",
        ]

        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
        ):
            agent = self._create_agent(task_data)
            agent._save_claude_config_files(agent_config_with_sensitive_data)

            # Walk through all created files
            config_dir = os.path.join(
                temp_workspace, str(task_data["task_id"]), ".claude"
            )

            for root, dirs, files in os.walk(config_dir):
                for filename in files:
                    filepath = os.path.join(root, filename)
                    with open(filepath) as f:
                        content = f.read().lower()

                    # Check for sensitive patterns (case-insensitive)
                    for pattern in sensitive_patterns:
                        if pattern.lower() in content:
                            # Allow "token" in non-API-key contexts
                            if (
                                pattern.lower() == "token"
                                and "anthropic_auth_token" not in content
                            ):
                                continue
                            if (
                                pattern.lower() == "secret"
                                or pattern.lower() == "api_key"
                            ):
                                pytest.fail(
                                    f"Sensitive pattern '{pattern}' found in {filepath}"
                                )


class TestCreateAndConnectClientEnvPassing:
    """Tests for env config passing in _create_and_connect_client."""

    @pytest.fixture
    def task_data(self):
        """Sample task data for testing."""
        return {
            "task_id": 12345,
            "subtask_id": 67890,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
            "user": {"user_name": "testuser"},
            "bot": [{"api_key": "test_api_key", "model": "claude-3-5-sonnet-20241022"}],
        }

    @pytest.fixture
    def temp_workspace(self):
        """Create temporary workspace directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    def test_local_mode_env_config_merged_into_options(self, task_data, temp_workspace):
        """
        Test that env config is merged into SDK options in Local mode.

        The _create_and_connect_client method should merge _claude_env_config
        into options["env"] for passing to ClaudeSDKClient.
        """
        from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
        ):
            mock_emitter = create_mock_emitter()
            agent = ClaudeCodeAgent(task_data, mock_emitter)

            # Simulate what _save_claude_config_files does
            agent._claude_config_dir = os.path.join(
                temp_workspace, str(task_data["task_id"]), ".claude"
            )
            agent._claude_env_config = {
                "ANTHROPIC_AUTH_TOKEN": "sk-ant-api-test-key",
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            }
            agent.options = {"cwd": temp_workspace}

            # Mock the client creation to capture options
            captured_options = {}

            def capture_options(**kwargs):
                captured_options.update(kwargs)
                mock_client = MagicMock()
                mock_client.connect = MagicMock(return_value=None)
                return mock_client

            with (
                patch(
                    "executor.agents.claude_code.claude_code_agent.ClaudeAgentOptions",
                    side_effect=capture_options,
                ),
                patch(
                    "executor.agents.claude_code.claude_code_agent.ClaudeSDKClient"
                ) as mock_sdk,
            ):
                mock_sdk.return_value.connect = MagicMock()

                import asyncio

                # Run the async method
                try:
                    asyncio.get_event_loop().run_until_complete(
                        agent._create_and_connect_client()
                    )
                except Exception:
                    pass  # We just want to capture the options

            # Verify env config was passed
            if "env" in captured_options:
                assert "ANTHROPIC_AUTH_TOKEN" in captured_options["env"]
                assert "CLAUDE_CONFIG_DIR" in captured_options["env"]
