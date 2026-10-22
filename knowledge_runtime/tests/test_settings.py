# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime settings support isolated deployment variables and legacy aliases."""

import pytest

from knowledge_runtime.config import Settings


@pytest.mark.parametrize("prefix", ["", "KNOWLEDGE_RUNTIME_"])
def test_loads_runtime_settings_from_environment(
    monkeypatch: pytest.MonkeyPatch, prefix: str
) -> None:
    values = {
        "CONTENT_FETCH_TIMEOUT": "71",
        "LOG_FILE_ENABLED": "false",
        "LOG_DIR": "./test-logs",
        "LOG_LEVEL": "WARNING",
        "INTERNAL_SERVICE_TOKEN": "synthetic-token",
    }
    for name, value in values.items():
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv("KNOWLEDGE_RUNTIME_" + name, raising=False)
        monkeypatch.setenv(prefix + name, value)
    settings = Settings(_env_file=None)
    assert settings.content_fetch_timeout == 71
    assert settings.log_file_enabled is False
    assert settings.log_dir == "./test-logs"
    assert settings.log_level == "WARNING"
    assert settings.internal_service_token == "synthetic-token"


def test_prefixed_settings_take_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "legacy-token")
    monkeypatch.setenv("KNOWLEDGE_RUNTIME_INTERNAL_SERVICE_TOKEN", "runtime-token")
    assert Settings(_env_file=None).internal_service_token == "runtime-token"
