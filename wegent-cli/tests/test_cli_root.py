import json

import yaml
from click.testing import CliRunner

from wegent.cli import cli


def test_masked_config_merges_defaults_and_masks_set_secrets():
    from wegent.commands.config import _masked_config

    payload = _masked_config({"server": "http://backend", "token": "secret-token"})

    assert payload["server"] == "http://backend"
    assert payload["namespace"] == "default"
    assert payload["mode"] == "chat"
    assert payload["token"] == "****"
    assert payload["api_key"] is None


def test_help_shows_new_command_groups():
    result = CliRunner().invoke(cli, ["--help"])

    assert result.exit_code == 0
    assert "kind" in result.output
    assert "task" in result.output
    assert "response" in result.output
    assert "ask" in result.output
    assert "get " not in result.output
    assert "apply " not in result.output


def test_config_view_json_masks_secrets(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.config.CONFIG_FILE", config_file)

    runner = CliRunner()
    runner.invoke(cli, ["config", "set", "server", "http://backend"])
    runner.invoke(cli, ["config", "set", "token", "secret-token"])
    runner.invoke(cli, ["config", "set", "api_key", "secret-key"])

    result = runner.invoke(cli, ["config", "view", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert payload["data"]["server"] == "http://backend"
    assert payload["data"]["token"] == "****"
    assert payload["data"]["api_key"] == "****"


def test_config_set_does_not_persist_env_only_credentials(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.config.CONFIG_FILE", config_file)
    monkeypatch.setenv("WEGENT_TOKEN", "env-token")
    monkeypatch.setenv("WEGENT_API_KEY", "env-key")

    result = CliRunner().invoke(cli, ["config", "set", "server", "http://backend"])

    assert result.exit_code == 0
    persisted = yaml.safe_load(config_file.read_text())
    assert persisted["server"] == "http://backend"
    assert "token" not in persisted
    assert "api_key" not in persisted


def test_config_unset_removes_key(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.config.CONFIG_FILE", config_file)

    runner = CliRunner()
    runner.invoke(cli, ["config", "set", "mode", "task"])
    result = runner.invoke(cli, ["config", "unset", "mode", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["data"]["key"] == "mode"


def test_config_unset_default_only_key_does_not_persist_config(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.config.CONFIG_FILE", config_file)
    monkeypatch.setenv("WEGENT_TOKEN", "env-token")
    monkeypatch.setenv("WEGENT_API_KEY", "env-key")

    result = CliRunner().invoke(cli, ["config", "unset", "mode", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["data"] == {"key": "mode", "removed": False}
    assert not config_file.exists()
