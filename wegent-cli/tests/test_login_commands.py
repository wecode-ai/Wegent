from click.testing import CliRunner
import yaml

from wegent.cli import cli


class FakeResponse:
    def __init__(self, status_code: int, payload: dict, text: str = ""):
        self.status_code = status_code
        self.payload = payload
        self.text = text
        self.reason = text

    def json(self):
        return self.payload


def _read_config(config_file):
    return yaml.safe_load(config_file.read_text()) or {}


def test_password_login_success_saves_auth_config_without_env_api_key(
    monkeypatch, tmp_path
):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.login.CONFIG_FILE", config_file)
    monkeypatch.setenv("WEGENT_API_KEY", "env-key")
    monkeypatch.setattr(
        "wegent.commands.login._do_password_login",
        lambda api_server, username, password: FakeResponse(
            200, {"access_token": "token-1"}
        ),
    )

    result = CliRunner().invoke(
        cli,
        [
            "login",
            "-u",
            "alice",
            "-p",
            "pw",
            "--method",
            "password",
            "-s",
            "http://backend",
        ],
    )

    assert result.exit_code == 0
    config = _read_config(config_file)
    assert config["token"] == "token-1"
    assert config["auth_method"] == "password"
    assert config["username"] == "alice"
    assert config["server"] == "http://backend"
    assert "api_key" not in config


def test_password_login_failure_does_not_persist_token(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.login.CONFIG_FILE", config_file)
    monkeypatch.setattr(
        "wegent.commands.login._do_password_login",
        lambda api_server, username, password: FakeResponse(
            400, {"detail": "bad credentials"}
        ),
    )

    result = CliRunner().invoke(
        cli,
        [
            "login",
            "-u",
            "alice",
            "-p",
            "bad",
            "--method",
            "password",
            "-s",
            "http://backend",
        ],
    )

    assert result.exit_code == 1
    assert not config_file.exists()


def test_oidc_login_success_saves_auth_config(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.setattr("wegent.commands.login.CONFIG_FILE", config_file)
    monkeypatch.setattr(
        "wegent.commands.login._do_oidc_login",
        lambda api_server: {
            "success": True,
            "token": "oidc-token",
            "username": "oidc-user",
        },
    )

    result = CliRunner().invoke(
        cli,
        ["login", "--method", "oidc", "-s", "http://backend"],
    )

    assert result.exit_code == 0
    config = _read_config(config_file)
    assert config["token"] == "oidc-token"
    assert config["auth_method"] == "oidc"
    assert config["username"] == "oidc-user"
    assert config["server"] == "http://backend"


def test_logout_removes_auth_keys_and_keeps_non_auth_config(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.safe_dump(
            {
                "server": "http://backend",
                "token": "token-1",
                "auth_method": "password",
                "username": "alice",
            }
        )
    )
    monkeypatch.setattr("wegent.commands.login.CONFIG_FILE", config_file)

    result = CliRunner().invoke(cli, ["logout"])

    assert result.exit_code == 0
    config = _read_config(config_file)
    assert config == {"server": "http://backend"}


def test_logout_does_not_persist_env_only_api_key(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(yaml.safe_dump({"server": "http://backend"}))
    monkeypatch.setattr("wegent.commands.login.CONFIG_FILE", config_file)
    monkeypatch.setenv("WEGENT_API_KEY", "env-key")

    result = CliRunner().invoke(cli, ["logout"])

    assert result.exit_code == 0
    config = _read_config(config_file)
    assert config == {"server": "http://backend"}
