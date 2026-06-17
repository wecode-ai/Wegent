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
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor.agents.claude_code.docker_mode_strategy import DockerModeStrategy
from executor.agents.claude_code.local_mode_strategy import LocalModeStrategy
from executor.agents.claude_code.mode_strategy import (
    ModeStrategyFactory,
)
from shared.models.execution import ExecutionRequest


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

    @pytest.fixture(autouse=True)
    def clear_process_custom_headers(self, monkeypatch):
        """Keep process-level custom headers isolated per test."""
        monkeypatch.delenv("ANTHROPIC_CUSTOM_HEADERS", raising=False)

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
        """Test task Claude config directory path for non-project tasks."""
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir = strategy.get_config_directory(task_id=12345)
            expected = os.path.join(temp_workspace, "12345", ".claude")
            assert config_dir == expected

    def test_get_config_directory_uses_global_for_project_tasks(
        self, strategy, temp_workspace, tmp_path, monkeypatch
    ):
        """Test global Claude config directory path for project tasks."""
        strategy.use_global_capabilities(True)
        monkeypatch.setenv("HOME", str(tmp_path))
        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir = strategy.get_config_directory(task_id=12345)
            assert config_dir == os.path.join(str(tmp_path), ".claude")

    def test_save_config_files_does_not_write_settings_json_when_no_hook(
        self,
        strategy,
        temp_workspace,
        tmp_path,
        monkeypatch,
        agent_config,
        claude_json_config,
    ):
        """Test that settings.json is NOT created (security)."""
        monkeypatch.setenv("HOME", str(tmp_path))
        with (
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
            patch.dict(os.environ, {"WEGENT_FILE_EDIT_HOOK_COMMAND": ""}, clear=False),
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            settings_path = os.path.join(config_dir, "settings.json")
            assert not os.path.exists(settings_path), "settings.json should NOT exist"
            assert config_dir == os.path.join(temp_workspace, "12345", ".claude")

    def test_save_config_files_writes_file_edit_hook_settings_when_configured(
        self,
        strategy,
        temp_workspace,
        tmp_path,
        monkeypatch,
        agent_config,
        claude_json_config,
    ):
        """Test WEGENT_FILE_EDIT_HOOK_COMMAND creates a hook-only settings file."""
        strategy.use_global_capabilities(True)
        monkeypatch.setenv("HOME", str(tmp_path))
        hook_command = (
            "curl -sS -X POST http://127.0.0.1:3456/api/file-edit-log "
            '-H "Content-Type: application/json" --data-binary @-'
        )
        global_settings_path = tmp_path / ".claude" / "settings.json"
        global_settings_path.parent.mkdir(parents=True)
        global_settings_path.write_text(
            json.dumps({"enabledPlugins": {"context7@market": True}})
        )

        with (
            patch(
                "executor.config.config.get_workspace_root", return_value=temp_workspace
            ),
            patch.dict(
                os.environ,
                {"WEGENT_FILE_EDIT_HOOK_COMMAND": hook_command},
                clear=False,
            ),
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

            settings_path = os.path.join(config_dir, "settings.json")
            with open(settings_path) as f:
                saved_config = json.load(f)

            assert saved_config == {
                "enabledPlugins": {"context7@market": True},
                "hooks": {
                    "PostToolUse": [
                        {
                            "matcher": "Write|Edit",
                            "hooks": [{"type": "command", "command": hook_command}],
                        }
                    ]
                },
            }

    def test_save_config_files_restores_global_managed_plugins_for_project_tasks(
        self,
        strategy,
        temp_workspace,
        tmp_path,
        monkeypatch,
        agent_config,
        claude_json_config,
    ):
        """Test project tasks restore Wegent plugin enablement before Claude starts."""
        strategy.use_global_capabilities(True)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("WEGENT_EXECUTOR_HOME", str(tmp_path / ".wegent-executor"))
        plugin_store = (
            tmp_path
            / ".wegent-executor"
            / "capabilities"
            / "store"
            / "plugins"
            / "1614-wegent-superpowers-5.0.7"
        )
        plugin_store.mkdir(parents=True)
        (plugin_store / ".claude-plugin").mkdir()
        (plugin_store / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "superpowers", "version": "5.0.7"})
        )
        claude_plugins_dir = tmp_path / ".claude" / "plugins"
        claude_plugins_dir.mkdir(parents=True)
        runtime_link = claude_plugins_dir / "cache" / "wegent" / "superpowers" / "5.0.7"
        manifest_path = tmp_path / ".wegent-executor" / "capabilities" / "manifest.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "revision": 1,
                    "skills": {},
                    "plugins": {
                        "superpowers@wegent": {
                            "name": "superpowers",
                            "installed_plugin_id": 1614,
                            "marketplace": "wegent",
                            "version": "5.0.7",
                            "store_path": str(plugin_store),
                            "runtime": {"claude_link": str(runtime_link)},
                            "managed": True,
                        }
                    },
                    "mcps": {},
                }
            )
        )
        (claude_plugins_dir / "installed_plugins.json").write_text(
            json.dumps({"version": 2, "plugins": {}})
        )

        with patch(
            "executor.config.config.get_workspace_root", return_value=temp_workspace
        ):
            config_dir, _ = strategy.save_config_files(
                task_id=12345,
                agent_config=agent_config,
                claude_json_config=claude_json_config,
            )

        settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
        installed = json.loads(
            (claude_plugins_dir / "installed_plugins.json").read_text()
        )
        assert config_dir == str(tmp_path / ".claude")
        assert settings["enabledPlugins"]["superpowers@wegent"] is True
        assert installed["plugins"]["superpowers@wegent"][0]["installPath"] == str(
            runtime_link
        )
        assert runtime_link.is_symlink()
        assert runtime_link.resolve() == plugin_store.resolve()

    def test_save_config_files_writes_claude_json(
        self,
        strategy,
        temp_workspace,
        tmp_path,
        monkeypatch,
        agent_config,
        claude_json_config,
    ):
        """Test that claude.json is created with correct content."""
        monkeypatch.setenv("HOME", str(tmp_path))
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
            assert os.path.exists(os.path.join(temp_workspace, "12345", ".claude"))

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

    def test_configure_client_options_merges_env(self, strategy, tmp_path, monkeypatch):
        """Test that env config is merged into options."""
        monkeypatch.setenv("HOME", str(tmp_path))
        options = {"cwd": "/workspace", "env": {"EXISTING_VAR": "value"}}
        env_config = {
            "ANTHROPIC_AUTH_TOKEN": "test-token",
            "ANTHROPIC_MODEL": "claude-model",
        }
        config_dir = "/workspace/12345/.claude"
        task_identity_env = {
            "WEGENT_SKILL_IDENTITY_TOKEN": "skill-jwt",
            "WEGENT_SKILL_USER_NAME": "alice",
        }

        result = strategy.configure_client_options(
            options, config_dir, env_config, task_identity_env
        )

        assert "EXISTING_VAR" in result["env"]
        assert "ANTHROPIC_AUTH_TOKEN" in result["env"]
        assert "ANTHROPIC_MODEL" in result["env"]
        assert (
            result["env"]["WEGENT_SKILL_IDENTITY_TOKEN"]
            == task_identity_env["WEGENT_SKILL_IDENTITY_TOKEN"]
        )
        assert (
            result["env"]["WEGENT_SKILL_USER_NAME"]
            == task_identity_env["WEGENT_SKILL_USER_NAME"]
        )
        assert result["env"]["CLAUDE_CONFIG_DIR"] == config_dir
        assert result["env"]["SKILLS_DIR"] == "/workspace/12345/.claude/skills"

    def test_configure_client_options_sets_claude_config_dir(
        self, strategy, tmp_path, monkeypatch
    ):
        """Test that CLAUDE_CONFIG_DIR is set correctly."""
        monkeypatch.setenv("HOME", str(tmp_path))
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, {}, {})

        assert result["env"]["CLAUDE_CONFIG_DIR"] == config_dir
        assert result["env"]["SKILLS_DIR"] == "/workspace/12345/.claude/skills"

    def test_configure_client_options_uses_global_config_dir_for_project_tasks(
        self, strategy, tmp_path, monkeypatch
    ):
        """Test project tasks use global Claude config and skills directories."""
        strategy.use_global_capabilities(True)
        monkeypatch.setenv("HOME", str(tmp_path))
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, {}, {})

        assert result["env"]["CLAUDE_CONFIG_DIR"] == str(tmp_path / ".claude")
        assert result["env"]["SKILLS_DIR"] == str(tmp_path / ".claude" / "skills")

    def test_configure_client_options_adds_project_header_for_project_tasks(
        self, strategy, tmp_path, monkeypatch
    ):
        """Project tasks should mark Claude API requests with the project ID."""
        strategy.use_global_capabilities(True, project_id=42)
        monkeypatch.setenv("HOME", str(tmp_path))
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, {}, {})

        assert result["env"]["ANTHROPIC_CUSTOM_HEADERS"] == (
            "wecode-action: wegent\n"
            "wecode-source: wegent-local\n"
            "wecode-executor: claudecode\n"
            "wecode-project: 42"
        )

    def test_configure_client_options_treats_project_zero_as_project(
        self, strategy, tmp_path, monkeypatch
    ):
        """Project ID 0 should still mark Claude API requests as project-backed."""
        strategy.use_global_capabilities(True, project_id=0)
        monkeypatch.setenv("HOME", str(tmp_path))
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, {}, {})

        assert result["env"]["ANTHROPIC_CUSTOM_HEADERS"] == (
            "wecode-action: wegent\n"
            "wecode-source: wegent-local\n"
            "wecode-executor: claudecode\n"
            "wecode-project: 0"
        )

    def test_configure_client_options_preserves_custom_headers_for_project_tasks(
        self, strategy, tmp_path, monkeypatch
    ):
        """Project header should be merged with existing Claude headers."""
        strategy.use_global_capabilities(True, project_id=42)
        monkeypatch.setenv("HOME", str(tmp_path))
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"
        env_config = {"ANTHROPIC_CUSTOM_HEADERS": "x-custom-user: test"}

        result = strategy.configure_client_options(options, config_dir, env_config, {})

        assert result["env"]["ANTHROPIC_CUSTOM_HEADERS"] == (
            "x-custom-user: test\n"
            "wecode-action: wegent\n"
            "wecode-source: wegent-local\n"
            "wecode-executor: claudecode\n"
            "wecode-project: 42"
        )

    def test_configure_client_options_appends_project_to_process_headers(
        self, strategy, tmp_path, monkeypatch
    ):
        """Project tasks should merge project ID with process startup headers."""
        strategy.use_global_capabilities(True, project_id=42)
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv(
            "ANTHROPIC_CUSTOM_HEADERS",
            "wecode-source: wegent-local\n"
            "wecode-action: wegent\n"
            "wecode-executor: claudecode",
        )
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, {}, {})

        assert result["env"]["ANTHROPIC_CUSTOM_HEADERS"] == (
            "wecode-source: wegent-local\n"
            "wecode-action: wegent\n"
            "wecode-executor: claudecode\n"
            "wecode-project: 42"
        )

    def test_configure_client_options_preserves_default_source_header_for_project_tasks(
        self, strategy, tmp_path, monkeypatch
    ):
        """Project tasks should preserve Wecode CLI source and add project ID."""
        strategy.use_global_capabilities(True, project_id=42)
        monkeypatch.setenv("HOME", str(tmp_path))
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"
        env_config = {
            "DEFAULT_HEADERS": {
                "wecode-action": "wecode-cli",
                "wecode-source": "wecode-cli",
                "x-weibo-downstream": "shanghai-intranet",
            }
        }

        result = strategy.configure_client_options(
            options,
            config_dir,
            env_config,
            {},
        )

        assert result["env"]["ANTHROPIC_CUSTOM_HEADERS"] == (
            "wecode-action: wecode-cli\n"
            "wecode-source: wecode-cli\n"
            "x-weibo-downstream: shanghai-intranet\n"
            "wecode-executor: claudecode\n"
            "wecode-project: 42"
        )
        assert json.loads(result["env"]["DEFAULT_HEADERS"]) == {
            "wecode-action": "wecode-cli",
            "wecode-source": "wecode-cli",
            "x-weibo-downstream": "shanghai-intranet",
            "wecode-executor": "claudecode",
            "wecode-project": "42",
        }
        assert result["env"]["default_headers"] == result["env"]["DEFAULT_HEADERS"]

    def test_configure_client_options_adds_anthropic_custom_headers(
        self, strategy, monkeypatch
    ):
        """Test that ANTHROPIC_CUSTOM_HEADERS is added when configured."""
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"
        custom_headers = "x-custom-user: test\nx-custom-source: executor"
        monkeypatch.setenv("ANTHROPIC_CUSTOM_HEADERS", custom_headers)

        result = strategy.configure_client_options(options, config_dir, {}, {})

        assert result["env"]["ANTHROPIC_CUSTOM_HEADERS"] == custom_headers

    def test_configure_client_options_no_custom_headers_when_empty(self, strategy):
        """Test that ANTHROPIC_CUSTOM_HEADERS is not added when empty."""
        options = {"cwd": "/workspace"}
        config_dir = "/workspace/12345/.claude"

        result = strategy.configure_client_options(options, config_dir, {}, {})

        assert "ANTHROPIC_CUSTOM_HEADERS" not in result["env"]

    def test_configure_client_options_refreshes_task_identity_without_mutating_input(
        self, strategy
    ):
        """Task identity env should refresh per call without mutating base options."""
        options = {"cwd": "/workspace", "env": {"EXISTING_VAR": "value"}}
        config_dir = "/workspace/12345/.claude"

        first = strategy.configure_client_options(
            options,
            config_dir,
            {},
            {"WEGENT_SKILL_IDENTITY_TOKEN": "token-1"},
        )
        second = strategy.configure_client_options(
            options,
            config_dir,
            {},
            {"WEGENT_SKILL_IDENTITY_TOKEN": "token-2"},
        )

        assert options["env"] == {"EXISTING_VAR": "value"}
        assert first["env"]["WEGENT_SKILL_IDENTITY_TOKEN"] == "token-1"
        assert second["env"]["WEGENT_SKILL_IDENTITY_TOKEN"] == "token-2"
        assert "WEGENT_SKILL_IDENTITY_TOKEN" not in os.environ

    def test_get_skills_directory_with_config_dir(
        self, strategy, tmp_path, monkeypatch
    ):
        """Test skills directory within task config dir."""
        monkeypatch.setenv("HOME", str(tmp_path))
        config_dir = "/workspace/12345/.claude"
        skills_dir = strategy.get_skills_directory(config_dir)
        assert skills_dir == "/workspace/12345/.claude/skills"

    def test_get_skills_directory_uses_global_for_project_tasks(
        self, strategy, tmp_path, monkeypatch
    ):
        """Test project tasks use the global skills directory."""
        strategy.use_global_capabilities(True)
        monkeypatch.setenv("HOME", str(tmp_path))
        config_dir = "/workspace/12345/.claude"
        skills_dir = strategy.get_skills_directory(config_dir)
        assert skills_dir == str(tmp_path / ".claude" / "skills")

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

    def test_configure_client_options_injects_task_identity_env(self, strategy):
        """Docker mode should inject task identity env for task-scoped child context."""
        original_options = {
            "cwd": "/workspace",
            "env": {"SOME_VAR": "value"},
            "max_turns": 10,
        }
        task_identity_env = {
            "WEGENT_SKILL_IDENTITY_TOKEN": "skill-jwt",
            "WEGENT_SKILL_USER_NAME": "alice",
        }

        result = strategy.configure_client_options(
            options=original_options,
            config_dir="/irrelevant",
            env_config={},
            task_identity_env=task_identity_env,
        )

        assert result["cwd"] == original_options["cwd"]
        assert result["max_turns"] == original_options["max_turns"]
        assert result["env"]["SOME_VAR"] == "value"
        assert result["env"]["WEGENT_SKILL_IDENTITY_TOKEN"] == "skill-jwt"
        assert result["env"]["WEGENT_SKILL_USER_NAME"] == "alice"
        assert result["env"]["SKILLS_DIR"] == strategy.get_skills_directory()
        assert original_options["env"] == {"SOME_VAR": "value"}
        assert "WEGENT_SKILL_IDENTITY_TOKEN" not in os.environ

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


def create_mock_emitter():
    """Create a mock emitter for testing."""
    emitter = MagicMock()
    emitter.in_progress = AsyncMock()
    emitter.start = AsyncMock()
    emitter.done = AsyncMock()
    emitter.error = AsyncMock()
    emitter.text_delta = AsyncMock()
    return emitter


class TestStrategyIntegration:
    """Integration tests for strategy pattern with ClaudeCodeAgent."""

    @pytest.fixture
    def task_data(self):
        """Sample task data."""
        return ExecutionRequest(
            task_id=12345,
            subtask_id=67890,
            bot=[
                {
                    "agent_config": {
                        "env": {
                            "ANTHROPIC_AUTH_TOKEN": "sk-ant-api-test",
                            "model": "claude-model",
                        }
                    }
                }
            ],
        )

    @pytest.fixture
    def mock_emitter(self):
        """Create a mock emitter for testing."""
        return create_mock_emitter()

    def test_agent_initializes_local_strategy(self, task_data, mock_emitter):
        """Test ClaudeCodeAgent initializes LocalModeStrategy in local mode."""
        with patch("executor.config.config.EXECUTOR_MODE", "local"):
            from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

            agent = ClaudeCodeAgent(task_data, mock_emitter)
            assert isinstance(agent._mode_strategy, LocalModeStrategy)

    def test_agent_initializes_docker_strategy(self, task_data, mock_emitter):
        """Test ClaudeCodeAgent initializes DockerModeStrategy in docker mode."""
        with patch("executor.config.config.EXECUTOR_MODE", ""):
            from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

            agent = ClaudeCodeAgent(task_data, mock_emitter)
            assert isinstance(agent._mode_strategy, DockerModeStrategy)
