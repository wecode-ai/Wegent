#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from executor.agents.codex.config_builder import (
    build_codex_config,
    is_codex_compatible_model,
)


@pytest.fixture(autouse=True)
def clear_local_cli_config(monkeypatch):
    monkeypatch.delenv("WEGENT_LOCAL_CLI_CONFIG_RUNTIMES", raising=False)


def test_is_codex_compatible_model_requires_openai_responses():
    assert is_codex_compatible_model({"model": "openai", "api_format": "responses"})
    assert is_codex_compatible_model({"model": "openai", "apiFormat": "responses"})
    assert is_codex_compatible_model(
        {"model": "openai", "protocol": "openai-responses"}
    )
    assert not is_codex_compatible_model(
        {"model": "openai", "api_format": "chat/completions"}
    )
    assert not is_codex_compatible_model({"model": "claude", "api_format": "responses"})


def test_build_codex_config_maps_provider_and_reasoning():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
            "reasoning": {"effort": "high", "summary": "concise"},
        }
    )

    assert config.model == "gpt-5.5"
    assert config.model_provider == "wecode-openai"
    assert "forced_login_method=api" in config.config_overrides
    assert "model_provider=wecode-openai" in config.config_overrides
    assert (
        "model_providers.wecode-openai.base_url=http://127.0.0.1:3456/v1"
        in config.config_overrides
    )
    assert "model_providers.wecode-openai.wire_api=responses" in config.config_overrides
    assert (
        "model_providers.wecode-openai.experimental_bearer_token=wecode-proxy-placeholder"
        in config.config_overrides
    )
    assert config.thread_config == {
        "model_reasoning_effort": "high",
        "model_reasoning_summary": "concise",
    }
    assert config.effort == "high"
    assert config.summary == "concise"


def test_build_codex_config_uses_local_cli_config(monkeypatch):
    monkeypatch.setenv("WEGENT_LOCAL_CLI_CONFIG_RUNTIMES", "codex")

    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "api_format": "responses",
            "reasoning": {"effort": "high", "summary": "concise"},
        }
    )

    assert config.model == "gpt-5.5"
    assert config.model_provider is None
    assert config.config_overrides == ("model=gpt-5.5",)
    assert config.thread_config == {
        "model_reasoning_effort": "high",
        "model_reasoning_summary": "concise",
    }


def test_build_codex_config_resolves_api_key_env_placeholder(monkeypatch):
    monkeypatch.setenv("WECODE_USER_API_KEY", "sk-from-executor-env")

    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "${WECODE_USER_API_KEY}",
            "api_format": "responses",
        }
    )

    assert (
        "model_providers.wecode-openai.experimental_bearer_token=sk-from-executor-env"
        in config.config_overrides
    )


def test_build_codex_config_splits_nested_reasoning_summary():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
            "reasoning": {"effort": {"summary": "detailed"}},
        }
    )

    assert config.thread_config == {"model_reasoning_summary": "detailed"}
    assert config.effort is None
    assert config.summary == "detailed"


def test_build_codex_config_filters_invalid_reasoning_values():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
            "reasoning": {"effort": "detailed", "summary": "verbose"},
        }
    )

    assert config.thread_config == {}
    assert config.effort is None
    assert config.summary is None
