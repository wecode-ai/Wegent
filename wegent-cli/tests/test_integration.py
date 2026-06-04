"""Stage smoke tests for the current Task 3 CLI command surface.

Task 7 will replace this file with backend-backed `ask` smoke coverage after the
ask command is implemented. Until then, this file verifies the new root command
surface without making backend, browser, or network calls.
"""

import json

from click.testing import CliRunner
import pytest

from wegent.cli import cli

pytestmark = pytest.mark.integration


def test_root_help_shows_current_command_surface():
    result = CliRunner().invoke(cli, ["--help"])

    assert result.exit_code == 0
    assert "kind" in result.output
    assert "task" in result.output
    assert "response" in result.output
    assert "ask" in result.output
    assert "api-resources" not in result.output
    assert "get " not in result.output
    assert "create " not in result.output
    assert "apply " not in result.output
    assert "delete " not in result.output
    assert "describe " not in result.output


def test_config_view_json_uses_env_overrides_and_masks_secrets(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.config.CONFIG_FILE", config_file)
    monkeypatch.setenv("WEGENT_SERVER", "http://env-backend")
    monkeypatch.setenv("WEGENT_NAMESPACE", "env-namespace")
    monkeypatch.setenv("WEGENT_TOKEN", "env-token")
    monkeypatch.setenv("WEGENT_API_KEY", "env-api-key")
    monkeypatch.setenv("WEGENT_MODE", "task")

    result = CliRunner().invoke(cli, ["config", "view", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert payload["data"] == {
        "server": "http://env-backend",
        "namespace": "env-namespace",
        "token": "****",
        "api_key": "****",
        "mode": "task",
    }


@pytest.mark.parametrize("command", ["kind", "task", "response", "ask"])
def test_placeholder_commands_expose_help(command):
    result = CliRunner().invoke(cli, [command, "--help"])

    assert result.exit_code == 0
    assert "Usage:" in result.output
