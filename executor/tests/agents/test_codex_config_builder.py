#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from executor.agents.codex.config_builder import (
    _resolve_codex_binary,
    build_codex_config,
    is_codex_compatible_model,
)


@pytest.fixture(autouse=True)
def isolate_executor_home(tmp_path, monkeypatch):
    monkeypatch.setenv("WEGENT_EXECUTOR_HOME", str(tmp_path / ".wegent-executor"))


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


def test_build_codex_config_adds_project_header_when_requested():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
        },
        project_id=42,
    )

    assert (
        'model_providers.wecode-openai.http_headers.wecode-project="42"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.wecode-action="wegent"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.wecode-source="wegent-local"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.wecode-executor="codex"'
        in config.config_overrides
    )


def test_build_codex_config_treats_project_zero_as_project():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
        },
        project_id=0,
    )

    assert (
        'model_providers.wecode-openai.http_headers.wecode-project="0"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.wecode-executor="codex"'
        in config.config_overrides
    )


def test_build_codex_config_preserves_default_source_header_when_project_requested():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
            "default_headers": {
                "wecode-action": "wecode-cli",
                "wecode-source": "wecode-cli",
                "x-weibo-downstream": "shanghai-intranet",
            },
        },
        project_id=42,
    )

    assert (
        'model_providers.wecode-openai.http_headers.wecode-action="wecode-cli"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.x-weibo-downstream="shanghai-intranet"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.wecode-source="wecode-cli"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.wecode-project="42"'
        in config.config_overrides
    )
    assert (
        'model_providers.wecode-openai.http_headers.wecode-executor="codex"'
        in config.config_overrides
    )


def test_build_codex_config_omits_project_header_by_default():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
        }
    )

    assert not any("wecode-project" in item for item in config.config_overrides)
    assert not any("wecode-executor" in item for item in config.config_overrides)
    assert not any("wecode-source" in item for item in config.config_overrides)
    assert not any("wecode-action" in item for item in config.config_overrides)


def test_build_codex_config_uses_user_runtime_config(monkeypatch):
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)

    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "api_format": "responses",
            "runtime_config": {
                "codex": {
                    "use_user_config": True,
                    "configured": True,
                    "target_path": "~/.codex/auth.json",
                    "use_proxy": True,
                }
            },
            "proxy": {"url": "http://127.0.0.1:7890"},
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
    assert config.env == {
        "HTTP_PROXY": "http://127.0.0.1:7890",
        "HTTPS_PROXY": "http://127.0.0.1:7890",
        "ALL_PROXY": "http://127.0.0.1:7890",
        "http_proxy": "http://127.0.0.1:7890",
        "https_proxy": "http://127.0.0.1:7890",
        "all_proxy": "http://127.0.0.1:7890",
        "NO_PROXY": "localhost,127.0.0.1,::1,host.docker.internal",
        "no_proxy": "localhost,127.0.0.1,::1,host.docker.internal",
    }


def test_build_codex_config_adds_project_header_to_user_runtime_provider():
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "api_format": "responses",
            "model_provider": "openai",
            "runtime_config": {
                "codex": {
                    "use_user_config": True,
                    "configured": True,
                    "target_path": "~/.codex/auth.json",
                }
            },
        },
        project_id=42,
    )

    assert config.model_provider == "openai"
    assert (
        'model_providers.openai.http_headers.wecode-project="42"'
        in config.config_overrides
    )
    assert (
        'model_providers.openai.http_headers.wecode-executor="codex"'
        in config.config_overrides
    )


def test_build_codex_config_uses_existing_no_proxy(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "localhost,.internal")

    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "api_format": "responses",
            "runtime_config": {
                "codex": {
                    "use_user_config": True,
                    "configured": True,
                    "use_proxy": True,
                }
            },
            "proxy": {"url": "socks5://127.0.0.1:7890"},
        }
    )

    assert config.env is not None
    assert config.env["HTTPS_PROXY"] == "socks5://127.0.0.1:7890"
    assert config.env["NO_PROXY"] == "localhost,.internal"
    assert config.env["no_proxy"] == "localhost,.internal"


def test_resolve_codex_binary_prefers_macos_app_bundle(monkeypatch):
    app_binary = "/Applications/Codex.app/Contents/Resources/codex"

    monkeypatch.setattr("executor.agents.codex.config_builder.sys.platform", "darwin")
    monkeypatch.setattr(
        "executor.agents.codex.config_builder.shutil.which",
        lambda value: "/opt/homebrew/bin/codex" if value == "codex" else None,
    )
    monkeypatch.setattr(
        "executor.agents.codex.config_builder.Path.exists",
        lambda path: str(path) == app_binary,
    )

    assert _resolve_codex_binary("codex") == app_binary


def test_resolve_codex_binary_preserves_explicit_path(monkeypatch):
    explicit_binary = "/usr/local/bin/codex"

    monkeypatch.setattr("executor.agents.codex.config_builder.sys.platform", "darwin")
    monkeypatch.setattr(
        "executor.agents.codex.config_builder.Path.exists",
        lambda path: str(path) == "/Applications/Codex.app/Contents/Resources/codex",
    )

    assert _resolve_codex_binary(explicit_binary) == explicit_binary


def test_build_codex_config_injects_global_mcp_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("WEGENT_EXECUTOR_HOME", str(tmp_path / ".wegent-executor"))
    manifest_path = tmp_path / ".wegent-executor" / "capabilities" / "manifest.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(
        json.dumps(
            {
                "version": 1,
                "revision": 1,
                "skills": {},
                "plugins": {},
                "mcps": {
                    "docs": {
                        "server": {
                            "type": "streamable-http",
                            "url": "https://mcp.example.com/docs",
                            "base_url": "https://ignored.example.com/docs",
                            "bearer_token_env_var": "DOCS_TOKEN",
                        }
                    },
                    "shell": {
                        "server": {
                            "type": "stdio",
                            "command": "uvx",
                            "args": ["tool", "--flag"],
                            "env": {"FOO": "bar"},
                        }
                    },
                },
            }
        )
    )

    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
        }
    )

    assert 'mcp_servers.docs.url="https://mcp.example.com/docs"' in (
        config.config_overrides
    )
    assert 'mcp_servers.docs.bearer_token_env_var="DOCS_TOKEN"' in (
        config.config_overrides
    )
    assert 'mcp_servers.shell.command="uvx"' in config.config_overrides
    assert 'mcp_servers.shell.args=["tool","--flag"]' in config.config_overrides
    assert 'mcp_servers.shell.env.FOO="bar"' in config.config_overrides


def test_build_codex_config_ignores_legacy_local_cli_env(monkeypatch):
    monkeypatch.setenv("WEGENT_LOCAL_CLI_CONFIG_RUNTIMES", "codex")

    with pytest.raises(ValueError, match="base_url"):
        build_codex_config(
            {
                "model": "openai",
                "model_id": "gpt-5.5",
                "api_format": "responses",
            }
        )


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
    assert config.thread_config == {"model_reasoning_effort": "medium"}


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

    assert config.thread_config == {
        "model_reasoning_effort": "medium",
        "model_reasoning_summary": "detailed",
    }
    assert config.effort == "medium"
    assert config.summary == "detailed"


def test_build_codex_config_defaults_invalid_reasoning_to_medium():
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

    assert config.thread_config == {"model_reasoning_effort": "medium"}
    assert config.effort == "medium"
    assert config.summary is None


@pytest.mark.parametrize(
    ("ui_value", "effort"),
    [
        ("extra_high", "xhigh"),
        ("Ultra", "xhigh"),
        ("超高", "xhigh"),
        ("高", "high"),
        ("中", "medium"),
        ("低", "low"),
        ("关闭", "medium"),
    ],
)
def test_build_codex_config_normalizes_ui_reasoning_aliases(ui_value, effort):
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
            "reasoning": ui_value,
        }
    )

    assert config.thread_config == {"model_reasoning_effort": effort}
    assert config.effort == effort


@pytest.mark.parametrize(
    ("ui_value", "service_tier"),
    [
        ("fast", "priority"),
        ("快速", "priority"),
        ("standard", "default"),
        ("标准", "default"),
    ],
)
def test_build_codex_config_normalizes_service_tier_aliases(ui_value, service_tier):
    config = build_codex_config(
        {
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses",
            "service_tier": ui_value,
        }
    )

    assert config.thread_config == {
        "model_reasoning_effort": "medium",
        "service_tier": service_tier,
    }
