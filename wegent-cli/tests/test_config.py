from pathlib import Path

import yaml

from wegent.config import (
    DEFAULT_CONFIG,
    get_api_key,
    get_mode,
    load_config,
    save_config,
)


def test_load_config_uses_defaults_when_file_missing(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    monkeypatch.delenv("WEGENT_SERVER", raising=False)
    monkeypatch.delenv("WEGENT_TOKEN", raising=False)
    monkeypatch.delenv("WEGENT_API_KEY", raising=False)
    monkeypatch.delenv("WEGENT_NAMESPACE", raising=False)
    monkeypatch.delenv("WEGENT_MODE", raising=False)

    config = load_config(config_file=config_file)

    assert config == DEFAULT_CONFIG


def test_load_config_uses_defaults_when_file_is_malformed(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text("server: [")
    monkeypatch.delenv("WEGENT_SERVER", raising=False)
    monkeypatch.delenv("WEGENT_TOKEN", raising=False)
    monkeypatch.delenv("WEGENT_API_KEY", raising=False)
    monkeypatch.delenv("WEGENT_NAMESPACE", raising=False)
    monkeypatch.delenv("WEGENT_MODE", raising=False)

    config = load_config(config_file=config_file)

    assert config == DEFAULT_CONFIG


def test_load_config_file_values_override_defaults(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.safe_dump(
            {
                "server": "http://backend:9000",
                "token": "file-token",
                "api_key": "file-api-key",
                "namespace": "file-ns",
                "mode": "task",
            }
        )
    )
    monkeypatch.delenv("WEGENT_SERVER", raising=False)
    monkeypatch.delenv("WEGENT_TOKEN", raising=False)
    monkeypatch.delenv("WEGENT_API_KEY", raising=False)
    monkeypatch.delenv("WEGENT_NAMESPACE", raising=False)
    monkeypatch.delenv("WEGENT_MODE", raising=False)

    config = load_config(config_file=config_file)

    assert config["server"] == "http://backend:9000"
    assert config["token"] == "file-token"
    assert config["api_key"] == "file-api-key"
    assert config["namespace"] == "file-ns"
    assert config["mode"] == "task"


def test_load_config_environment_overrides_file(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.safe_dump(
            {
                "server": "http://file:8000",
                "token": "file-token",
                "api_key": "file-api-key",
                "namespace": "file-ns",
                "mode": "chat",
            }
        )
    )
    monkeypatch.setenv("WEGENT_SERVER", "http://env:8000")
    monkeypatch.setenv("WEGENT_TOKEN", "env-token")
    monkeypatch.setenv("WEGENT_API_KEY", "env-api-key")
    monkeypatch.setenv("WEGENT_NAMESPACE", "env-ns")
    monkeypatch.setenv("WEGENT_MODE", "knowledge")

    config = load_config(config_file=config_file)

    assert config["server"] == "http://env:8000"
    assert config["token"] == "env-token"
    assert config["api_key"] == "env-api-key"
    assert config["namespace"] == "env-ns"
    assert config["mode"] == "knowledge"


def test_save_config_creates_parent_directory(tmp_path):
    config_file = tmp_path / "nested" / "config.yaml"

    save_config({"server": "http://saved:8000"}, config_file=config_file)

    assert config_file.exists()
    assert yaml.safe_load(config_file.read_text())["server"] == "http://saved:8000"


def test_getters_read_selected_config_file(monkeypatch, tmp_path):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(yaml.safe_dump({"api_key": "abc", "mode": "task"}))
    monkeypatch.delenv("WEGENT_API_KEY", raising=False)
    monkeypatch.delenv("WEGENT_MODE", raising=False)

    assert get_api_key(config_file=config_file) == "abc"
    assert get_mode(config_file=config_file) == "task"
