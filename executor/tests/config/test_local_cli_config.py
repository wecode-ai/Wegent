# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from executor.config.local_cli_config import use_local_cli_config


def test_use_local_cli_config_defaults_to_system(monkeypatch):
    monkeypatch.delenv("WEGENT_LOCAL_CLI_CONFIG_RUNTIMES", raising=False)

    assert not use_local_cli_config("codex")
    assert not use_local_cli_config("claude")


def test_use_local_cli_config_matches_comma_separated_runtime_names(monkeypatch):
    monkeypatch.setenv("WEGENT_LOCAL_CLI_CONFIG_RUNTIMES", " codex, Claude ")

    assert use_local_cli_config("codex")
    assert not use_local_cli_config("claude")
    assert not use_local_cli_config("agno")
