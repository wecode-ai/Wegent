import json

from click.testing import CliRunner

from wegent.cli import cli


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


def test_config_unset_removes_key(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.config.CONFIG_FILE", config_file)

    runner = CliRunner()
    runner.invoke(cli, ["config", "set", "mode", "task"])
    result = runner.invoke(cli, ["config", "unset", "mode", "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["data"]["key"] == "mode"
