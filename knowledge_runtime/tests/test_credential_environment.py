# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify deployment credential resolution with synthetic encryption material."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest
import uvicorn
import yaml

from knowledge_runtime.services.config_resolver import ConfigResolver
from shared.utils import crypto

from .conftest import _make_kb_kind, _make_model_kind, _make_retriever_kind

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SYNTHETIC_ENV = {
    "GIT_TOKEN_AES_KEY": "0123456789abcdef0123456789abcdef",
    "GIT_TOKEN_AES_IV": "0123456789abcdef",
}


def _reset_crypto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(crypto, "_aes_key", None)
    monkeypatch.setattr(crypto, "_aes_iv", None)


def _credential_resolver(
    monkeypatch: pytest.MonkeyPatch, credentials: dict[str, str]
) -> ConfigResolver:
    resolver = ConfigResolver()
    monkeypatch.setattr(resolver, "_get_knowledge_base", lambda *args: _make_kb_kind())
    monkeypatch.setattr(resolver, "_get_user_name", lambda *args: "testuser")
    monkeypatch.setattr(
        resolver,
        "_get_retriever_kind",
        lambda *args, **kwargs: _make_retriever_kind(
            storage_config={
                "type": "qdrant",
                "apiKey": credentials["storage-key"],
                "password": credentials["storage-password"],
            }
        ),
    )
    monkeypatch.setattr(
        resolver,
        "_get_model_kind",
        lambda **kwargs: _make_model_kind(
            spec={
                "protocol": "openai",
                "modelConfig": {"env": {"api_key": credentials["model-key"]}},
            }
        ),
    )
    return resolver


def test_compose_resolves_backend_encrypted_model_and_storage_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    services = yaml.safe_load((REPOSITORY_ROOT / "docker-compose.yml").read_text())[
        "services"
    ]
    backend_env = services["backend"]["environment"]
    runtime_env = dict(
        item.split("=", 1) for item in services["knowledge_runtime"]["environment"]
    )
    for name, value in SYNTHETIC_ENV.items():
        assert backend_env[name] == "${" + name + ":-}"
        monkeypatch.setenv(name, value)
    _reset_crypto(monkeypatch)
    credentials = {
        name: crypto.encrypt_api_key("synthetic-" + name)
        for name in ("model-key", "storage-key", "storage-password")
    }

    # Simulate a cold Runtime process using only its declared environment.
    for name, value in SYNTHETIC_ENV.items():
        monkeypatch.delenv(name)
        if runtime_env.get(name) == backend_env[name]:
            monkeypatch.setenv(name, value)
    _reset_crypto(monkeypatch)
    resolver = _credential_resolver(monkeypatch, credentials)

    result = resolver.resolve_index_config(MagicMock(), knowledge_base_id=1, user_id=42)

    assert (
        result.embedding_model_config.resolved_config["api_key"]
        == "synthetic-model-key"
    )
    assert result.retriever_config.storage_config["apiKey"] == "synthetic-storage-key"
    assert (
        result.retriever_config.storage_config["password"]
        == "synthetic-storage-password"
    )
    for name in SYNTHETIC_ENV:
        assert runtime_env[name] == backend_env[name]


@pytest.mark.parametrize("launcher_path", ["knowledge_runtime/start.sh", "start.sh"])
def test_launcher_loads_crypto_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, launcher_path: str
) -> None:
    for name, value in SYNTHETIC_ENV.items():
        monkeypatch.setenv(name, value)
    _reset_crypto(monkeypatch)
    ciphertext = crypto.encrypt_api_key("synthetic-standalone-key")
    for name in SYNTHETIC_ENV:
        monkeypatch.delenv(name)
    _reset_crypto(monkeypatch)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "".join(f"{name}={value}\n" for name, value in SYNTHETIC_ENV.items())
    )
    launcher = (REPOSITORY_ROOT / launcher_path).read_text()
    command = next(
        line
        for line in launcher.splitlines()
        if "uvicorn knowledge_runtime.main:app" in line
    )
    assert "--env-file .env" in command

    # Exercise Uvicorn's actual env-file loader without starting a server.
    uvicorn.Config("unused:app", env_file=env_file)

    assert (
        ConfigResolver._decrypt_optional_value(ciphertext) == "synthetic-standalone-key"
    )
