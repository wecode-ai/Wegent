# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Execution Mode Strategy Pattern.

This module tests the strategy pattern implementation for ClaudeCodeAgent,
including LocalModeStrategy, DockerModeStrategy, and ModeStrategyFactory.
"""

import json
import os
import stat
import tempfile
from unittest.mock import patch

import pytest

from executor.agents.claude_code.docker_mode_strategy import DockerModeStrategy
from executor.agents.claude_code.local_mode_strategy import LocalModeStrategy
from executor.agents.claude_code.mode_strategy import (
    ExecutionModeStrategy,
    ModeStrategyFactory,
)


class TestModeStrategyFactory:
    """Tests for ModeStrategyFactory."""

    def test_create_local_strategy_with_explicit_mode(self):
        """Test factory creates LocalModeStrategy for 'local' mode."""
        strategy = ModeStrategyFactory.create(mode="local")
        assert isinstance(strategy, LocalModeStrategy)

    def test_create_docker_strategy_with_explicit_mode(self):
        """Test factory creates DockerModeStrategy for 'docker' mode."""
        strategy = ModeStrategyFactory.create(mode="docker")
        assert isinstance(strategy, DockerModeStrategy)

    def test_create_docker_strategy_for_empty_mode(self):
        """Test factory creates DockerModeStrategy for empty mode string."""
        strategy = ModeStrategyFactory.create(mode="")
        assert isinstance(strategy, DockerModeStrategy)

    def test_create_docker_strategy_for_none_mode(self):
        """Test factory creates DockerModeStrategy when mode is None."""
        with patch("executor.config.config.EXECUTOR_MODE", ""):
            strategy = ModeStrategyFactory.create(mode=None)
            assert isinstance(strategy, DockerModeStrategy)

    def test_create_local_strategy_from_config(self):
        """Test factory reads mode from config when mode param is None."""
        with patch("executor.config.config.EXECUTOR_MODE", "local"):
            strategy = ModeStrategyFactory.create()
            assert isinstance(strategy, LocalModeStrategy)

    def test_create_docker_strategy_from_config(self):
        """Test factory reads mode from config when mode param is None."""
        with patch("executor.config.config.EXECUTOR_MODE", "docker"):
            strategy = ModeStrategyFactory.create()
            assert isinstance(strategy, DockerModeStrategy)


class TestLocalModeStrategy:
    """Tests for LocalModeStrategy."""

    @pytest.fixture
    def strategy(self):
        """Create LocalModeStrategy instance."""
        return LocalModeStrategy()

    @pytest.fixture
    def temp_workspace(self):
        """Create temporary workspace directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def agent_config(self):
        """Sample agent config with sensitive data."""
        return {
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "sk-ant-api-secret-test-key",
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                "ANTHROPIC_MODEL": "claude-3-5-sonnet-20241022",
            },
            "model": "claude-3-5-sonnet-20241022",
        }

    @pytest.fixture
    def claude_json_config(self):
        """Sample non-sensitive claude.json config."""
        return {
            "numStartups": 2,
            "hasCompletedOnboarding": True,
            "userID": "test-user-id",
        }

    def test_get_config_directory(self, strategy, temp_workspace):
        """Test task-specific config directory path."""
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir = strategy.get_config_directory(task_id=12345)
            expected = os.path.join(temp_workspace, "12345", ".claude")
            assert config_dir == expected

    def test_save_config_files_does_not_write_settings_json(
        self, strategy, temp_workspace, agent_config, claude_json_config
    ):
        """Test that settings.json is NOT created (security)."""
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            settings_path = os.path.join(config_dir, "settings.json")
            assert not os.path.exists(settings_path), "settings.json should NOT exist"

    def test_save_config_files_writes_claude_json(
        self, strategy, temp_workspace, agent_config, claude_json_config
    ):
        """Test that claude.json is created with correct content."""
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            claude_json_path = os.path.join(config_dir, "claude.json")
            assert os.path.exists(claude_json_path)

            with open(claude_json_path) as f:
                saved_config = json.load(f)

            assert saved_config == claude_json_config

    def test_save_config_files_returns_env_config(
        self, strategy, temp_workspace, agent_config, claude_json_config
    ):
        """Test that env config is returned for SDK env parameter."""
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            _, env_config = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            assert env_config == agent_config["env"]
            assert "ANTHROPIC_AUTH_TOKEN" in env_config

    def test_save_config_files_directory_permissions(
        self, strategy, temp_workspace, agent_config, claude_json_config
    ):
        """Test that .claude directory has 0700 permissions."""
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            dir_mode = stat.S_IMODE(os.stat(config_dir).st_mode)
            assert dir_mode == 0o700, f"Expected 0700, got {oct(dir_mode)}"

    def test_save_config_files_file_permissions(
        self, strategy, temp_workspace, agent_config, claude_json_config
    ):
        """Test that claude.json has 0600 permissions."""
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            claude_json_path = os.path.join(config_dir, "claude.json")
            file_mode = stat.S_IMODE(os.stat(claude_json_path).st_mode)
            assert file_mode == 0o600, f"Expected 0600, got {oct(file_mode)}"

    def test_configure_client_options_merges_env(self, strategy):
        """Test that env config is merged into options."""
        options = {"cwd": "/workspace", "env": {"EXISTING_VAR": "value"}}
        env_config = {
            "ANTHROPIC_AUTH_TOKEN": "test-token",
            "ANTHROPIC_MODEL": "claude-model",
        }
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, env_config)

        assert "EXISTING_VAR" in result["env"]
        assert "ANTHROPIC_AUTH_TOKEN" in result["env"]
        assert "ANTHROPIC_MODEL" in result["env"]
        assert result["env"]["CLAUDE_CONFIG_DIR"] == config_dir

    def test_configure_client_options_sets_claude_config_dir(self, strategy):
        """Test that CLAUDE_CONFIG_DIR is set correctly."""
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, {})

        assert result["env"]["CLAUDE_CONFIG_DIR"] == config_dir

    def test_configure_client_options_adds_anthropic_custom_headers(self, strategy):
        """Test that ANTHROPIC_CUSTOM_HEADERS is added when configured."""
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"
        custom_headers = "x-custom-user: test\nx-custom-source: executor"

        with patch("executor.config.config.ANTHROPIC_CUSTOM_HEADERS", custom_headers):
            result = strategy.configure_client_options(options, config_dir, {})

        assert result["env"]["ANTHROPIC_CUSTOM_HEADERS"] == custom_headers

    def test_configure_client_options_no_custom_headers_when_empty(self, strategy):
        """Test that ANTHROPIC_CUSTOM_HEADERS is not added when empty."""
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        with patch("executor.config.config.ANTHROPIC_CUSTOM_HEADERS", ""):
            result = strategy.configure_client_options(options, config_dir, {})

        assert "ANTHROPIC_CUSTOM_HEADERS" not in result["env"]

    def test_get_skills_directory_with_config_dir(self, strategy):
        """Test skills directory within task config dir."""
        config_dir = "/workspace/12345/.claude"
        skills_dir = strategy.get_skills_directory(config_dir)
        assert skills_dir == "/workspace/12345/.claude/skills"

    def test_get_skills_directory_fallback(self, strategy):
        """Test skills directory fallback when config_dir is None."""
        skills_dir = strategy.get_skills_directory(None)
        expected = os.path.expanduser("~/.claude/skills")
        assert skills_dir == expected

    def test_get_skills_deployment_options(self, strategy):
        """Test local mode deployment options."""
        options = strategy.get_skills_deployment_options()
        assert options["clear_cache"] is False
        assert options["skip_existing"] is True


class TestDockerModeStrategy:
    """Tests for DockerModeStrategy."""

    @pytest.fixture
    def strategy(self):
        """Create DockerModeStrategy instance."""
        return DockerModeStrategy()

    @pytest.fixture
    def temp_home(self):
        """Create temporary home directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def agent_config(self):
        """Sample agent config with sensitive data."""
        return {
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "sk-ant-api-test-key",
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
            },
            "model": "claude-3-5-sonnet-20241022",
        }

    @pytest.fixture
    def claude_json_config(self):
        """Sample non-sensitive claude.json config."""
        return {
            "numStartups": 2,
            "hasCompletedOnboarding": True,
            "userID": "test-user-id",
        }

    def test_get_config_directory(self, strategy, temp_home):
        """Test default ~/.claude directory path."""
        with patch("os.path.expanduser", return_value=f"{temp_home}/.claude"):
            config_dir = strategy.get_config_directory(task_id=12345)
            assert config_dir == f"{temp_home}/.claude"

    def test_save_config_files_writes_settings_json(
        self, strategy, temp_home, agent_config, claude_json_config
    ):
        """Test that settings.json IS created in Docker mode."""
        with patch(
            "os.path.expanduser", side_effect=lambda p: p.replace("~", temp_home)
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            settings_path = os.path.join(config_dir, "settings.json")
            assert os.path.exists(settings_path), "settings.json should exist"

            with open(settings_path) as f:
                saved_config = json.load(f)

            assert saved_config == agent_config

    def test_save_config_files_writes_claude_json(
        self, strategy, temp_home, agent_config, claude_json_config
    ):
        """Test that claude.json is created at ~/.claude.json."""
        with patch(
            "os.path.expanduser", side_effect=lambda p: p.replace("~", temp_home)
        ):
            strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            claude_json_path = os.path.join(temp_home, ".claude.json")
            assert os.path.exists(claude_json_path)

            with open(claude_json_path) as f:
                saved_config = json.load(f)

            assert saved_config == claude_json_config

    def test_save_config_files_returns_empty_env_config(
        self, strategy, temp_home, agent_config, claude_json_config
    ):
        """Test that empty env config is returned (config is in settings.json)."""
        with patch(
            "os.path.expanduser", side_effect=lambda p: p.replace("~", temp_home)
        ):
            _, env_config = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            assert env_config == {}

    def test_configure_client_options_unchanged(self, strategy):
        """Test that options are returned unchanged in Docker mode."""
        original_options = {
            "cwd": "/workspace",
            "env": {"SOME_VAR": "value"},
            "max_turns": 10,
        }

        result = strategy.configure_client_options(
            options=original_options.copy(), config_dir="/irrelevant", env_config={}
        )

        assert result == original_options

    def test_get_skills_directory(self, strategy, temp_home):
        """Test default ~/.claude/skills directory."""
        with patch(
            "os.path.expanduser", side_effect=lambda p: p.replace("~", temp_home)
        ):
            skills_dir = strategy.get_skills_directory()
            assert skills_dir == f"{temp_home}/.claude/skills"

    def test_get_skills_deployment_options(self, strategy):
        """Test Docker mode deployment options."""
        options = strategy.get_skills_deployment_options()
        assert options["clear_cache"] is True
        assert options["skip_existing"] is False


class TestStrategyIntegration:
    """Integration tests for strategy pattern with ClaudeCodeAgent."""

    @pytest.fixture
    def task_data(self):
        """Sample task data."""
        return {
            "task_id": 12345,
            "subtask_id": 67890,
            "bot": [
                {
                    "agent_config": {
                        "env": {
                            "ANTHROPIC_AUTH_TOKEN": "sk-ant-api-test",
                            "model": "claude-model",
                        }
                    }
                }
            ],
        }

    def test_agent_initializes_local_strategy(self, task_data):
        """Test ClaudeCodeAgent initializes LocalModeStrategy in local mode."""
        with patch("executor.config.config.EXECUTOR_MODE", "local"):
            from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

            agent = ClaudeCodeAgent(task_data)
            assert isinstance(agent._mode_strategy, LocalModeStrategy)

    def test_agent_initializes_docker_strategy(self, task_data):
        """Test ClaudeCodeAgent initializes DockerModeStrategy in docker mode."""
        with patch("executor.config.config.EXECUTOR_MODE", ""):
            from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

            agent = ClaudeCodeAgent(task_data)
            assert isinstance(agent._mode_strategy, DockerModeStrategy)
