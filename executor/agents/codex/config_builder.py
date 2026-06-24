#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from executor.agents.api_headers import (
    merge_project_header,
    merge_wegent_runtime_headers,
)
from executor.agents.env_value import resolve_env_value
from executor.config import config
from shared.logger import setup_logger

OPENAI_RESPONSES_PROTOCOL = "openai-responses"
RESPONSES_WIRE_API = "responses"
DEFAULT_PROVIDER_NAME = "wecode openai"
DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1,host.docker.internal"
MACOS_CODEX_APP_BINARY = "/Applications/Codex.app/Contents/Resources/codex"
CODEX_REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}
CODEX_REASONING_SUMMARIES = {"auto", "concise", "detailed"}
DEFAULT_REASONING_EFFORT = "medium"
REASONING_EFFORT_ALIASES = {
    "": DEFAULT_REASONING_EFFORT,
    "none": DEFAULT_REASONING_EFFORT,
    "off": DEFAULT_REASONING_EFFORT,
    "false": DEFAULT_REASONING_EFFORT,
    "disabled": DEFAULT_REASONING_EFFORT,
    "关闭": DEFAULT_REASONING_EFFORT,
    "低": "low",
    "中": "medium",
    "中等": "medium",
    "高": "high",
    "超高": "xhigh",
    "最高": "xhigh",
    "extra_high": "xhigh",
    "ultra": "xhigh",
    "x-high": "xhigh",
}
SERVICE_TIER_ALIASES = {
    "fast": "priority",
    "priority": "priority",
    "快速": "priority",
    "运行快速": "priority",
    "standard": "default",
    "default": "default",
    "普通": "default",
    "标准": "default",
    "运行标准": "default",
}

logger = setup_logger("codex_config_builder")


@dataclass(frozen=True)
class CodeXConfig:
    """Resolved Codex SDK configuration for one task run."""

    codex_bin: str
    model: str
    model_provider: Optional[str]
    config_overrides: tuple[str, ...]
    thread_config: dict[str, Any]
    effort: Optional[str]
    summary: Optional[str]
    env: Optional[dict[str, str]] = None


def is_codex_compatible_model(model_config: dict[str, Any]) -> bool:
    """Return whether an execution model should run through CodeXAgent."""
    provider = str(model_config.get("model") or "").lower()
    api_format = _read_api_format(model_config)
    protocol = str(model_config.get("protocol") or "").lower()
    wire_api = str(model_config.get("wire_api") or "").lower()

    return provider == "openai" and (
        api_format == RESPONSES_WIRE_API
        or protocol == OPENAI_RESPONSES_PROTOCOL
        or wire_api == RESPONSES_WIRE_API
    )


def build_codex_config(
    model_config: dict[str, Any],
    *,
    project_id: Any = None,
) -> CodeXConfig:
    """Build Codex SDK launch and thread parameters from Wegent model config."""
    model = str(model_config.get("model_id") or "").strip()
    if not model:
        raise ValueError("CodeXAgent requires model_config.model_id")

    local_config = _use_user_runtime_config(model_config, "codex")
    proxy_env = _build_runtime_proxy_env(model_config, "codex")
    reasoning = _normalize_reasoning(model_config.get("reasoning"))
    service_tier = _normalize_service_tier(model_config.get("service_tier"))
    mcp_overrides = _build_global_mcp_config_overrides()
    if local_config:
        model_provider = _resolve_explicit_model_provider(model_config)
        header_overrides = (
            _build_header_overrides(
                model_provider,
                model_config.get("default_headers"),
                project_id,
            )
            if model_provider
            else ()
        )
        overrides = [f"model={model}", *header_overrides, *mcp_overrides]
        return CodeXConfig(
            codex_bin=_resolve_codex_binary(config.CODEX_BINARY_PATH),
            model=model,
            model_provider=model_provider,
            config_overrides=tuple(overrides),
            thread_config=_build_thread_config(reasoning, service_tier),
            effort=reasoning.get("effort"),
            summary=reasoning.get("summary"),
            env=proxy_env,
        )

    base_url = str(model_config.get("base_url") or "").strip()
    if not base_url:
        raise ValueError("CodeXAgent requires model_config.base_url")

    api_key = resolve_env_value(
        str(model_config.get("api_key") or "").strip(), logger_override=logger
    ).strip()
    if not api_key:
        raise ValueError("CodeXAgent requires model_config.api_key")

    model_provider = _resolve_model_provider(model_config)
    wire_api = _resolve_wire_api(model_config)
    header_overrides = _build_header_overrides(
        model_provider,
        model_config.get("default_headers"),
        project_id,
    )

    overrides = [
        "forced_login_method=api",
        f"model={model}",
        f"model_provider={model_provider}",
        f"model_providers.{model_provider}.name={_resolve_provider_name(model_config)}",
        f"model_providers.{model_provider}.base_url={base_url.rstrip('/')}",
        f"model_providers.{model_provider}.wire_api={wire_api}",
        f"model_providers.{model_provider}.experimental_bearer_token={api_key}",
        *header_overrides,
        *mcp_overrides,
    ]

    return CodeXConfig(
        codex_bin=_resolve_codex_binary(config.CODEX_BINARY_PATH),
        model=model,
        model_provider=model_provider,
        config_overrides=tuple(overrides),
        thread_config=_build_thread_config(reasoning, service_tier),
        effort=reasoning.get("effort"),
        summary=reasoning.get("summary"),
        env=proxy_env,
    )


def _use_user_runtime_config(model_config: dict[str, Any], runtime: str) -> bool:
    runtime_config = _get_runtime_config(model_config, runtime)
    if not runtime_config:
        return False

    return bool(
        runtime_config.get("use_user_config") and runtime_config.get("configured", True)
    )


def _build_runtime_proxy_env(
    model_config: dict[str, Any], runtime: str
) -> Optional[dict[str, str]]:
    runtime_config = _get_runtime_config(model_config, runtime)
    if not runtime_config:
        return None
    if not runtime_config.get("use_proxy"):
        return None

    proxy = _get_proxy(model_config)
    proxy_url = str(proxy.get("url") or "").strip()
    if not proxy_url:
        return None

    no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy")
    if not no_proxy:
        no_proxy = DEFAULT_NO_PROXY

    return {
        "HTTP_PROXY": proxy_url,
        "HTTPS_PROXY": proxy_url,
        "ALL_PROXY": proxy_url,
        "http_proxy": proxy_url,
        "https_proxy": proxy_url,
        "all_proxy": proxy_url,
        "NO_PROXY": no_proxy,
        "no_proxy": no_proxy,
    }


def _get_runtime_config(
    model_config: dict[str, Any], runtime: str
) -> Optional[dict[str, Any]]:
    runtime_configs = model_config.get("runtime_config") or model_config.get(
        "runtimeConfig"
    )
    if not isinstance(runtime_configs, dict):
        return None

    runtime_config = runtime_configs.get(runtime)
    if not isinstance(runtime_config, dict):
        return None
    return runtime_config


def _get_proxy(model_config: dict[str, Any]) -> dict[str, Any]:
    proxy = model_config.get("proxy")
    return proxy if isinstance(proxy, dict) else {}


def _build_thread_config(
    reasoning: dict[str, str], service_tier: Optional[str]
) -> dict[str, Any]:
    thread_config: dict[str, Any] = {}
    if reasoning.get("effort"):
        thread_config["model_reasoning_effort"] = reasoning["effort"]
    if reasoning.get("summary"):
        thread_config["model_reasoning_summary"] = reasoning["summary"]
    if service_tier:
        thread_config["service_tier"] = service_tier
    return thread_config


def _resolve_model_provider(model_config: dict[str, Any]) -> str:
    provider = (
        model_config.get("codex_model_provider")
        or model_config.get("model_provider")
        or model_config.get("provider")
        or config.CODEX_MODEL_PROVIDER
    )
    return _sanitize_provider_id(str(provider or config.CODEX_MODEL_PROVIDER))


def _resolve_explicit_model_provider(model_config: dict[str, Any]) -> Optional[str]:
    provider = (
        model_config.get("codex_model_provider")
        or model_config.get("model_provider")
        or model_config.get("provider")
    )
    if not provider:
        return None
    return _sanitize_provider_id(str(provider))


def _resolve_provider_name(model_config: dict[str, Any]) -> str:
    return str(
        model_config.get("provider_name")
        or model_config.get("display_name")
        or DEFAULT_PROVIDER_NAME
    )


def _resolve_wire_api(model_config: dict[str, Any]) -> str:
    api_format = _read_api_format(model_config)
    wire_api = str(model_config.get("wire_api") or "").lower()
    protocol = str(model_config.get("protocol") or "").lower()
    if api_format == RESPONSES_WIRE_API or protocol == OPENAI_RESPONSES_PROTOCOL:
        return RESPONSES_WIRE_API
    return wire_api or RESPONSES_WIRE_API


def _build_header_overrides(
    model_provider: str,
    default_headers: Any,
    project_id: Any,
) -> tuple[str, ...]:
    project_headers = merge_project_header({}, project_id)
    headers = (
        merge_wegent_runtime_headers(default_headers, executor="codex")
        if project_headers
        else default_headers
    )
    headers = merge_project_header(headers, project_id)
    if not headers:
        return ()
    return tuple(
        f"{_toml_key_path('model_providers', model_provider, 'http_headers', key)}="
        f"{_toml_value(value)}"
        for key, value in headers.items()
    )


def _read_api_format(model_config: dict[str, Any]) -> str:
    return str(
        model_config.get("api_format") or model_config.get("apiFormat") or ""
    ).lower()


def _sanitize_provider_id(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9_-]+", "-", value.strip()).strip("-")
    return sanitized or config.CODEX_MODEL_PROVIDER


def _resolve_codex_binary(value: str) -> str:
    if "/" in value or "\\" in value:
        return value
    if value == "codex" and sys.platform == "darwin":
        app_binary = Path(MACOS_CODEX_APP_BINARY)
        if app_binary.exists():
            return str(app_binary)
    return shutil.which(value) or value


def _build_global_mcp_config_overrides() -> tuple[str, ...]:
    """Build Codex CLI config overrides from synced global MCP records."""
    try:
        from executor.modes.local.capabilities import GlobalCapabilityStore

        manifest = GlobalCapabilityStore().load()
    except Exception as exc:
        logger.warning("Failed to load global MCP manifest for Codex: %s", exc)
        return ()

    overrides: list[str] = []
    for name, record in sorted((manifest.get("mcps") or {}).items()):
        if not isinstance(record, dict):
            continue
        server = record.get("server") or {}
        if not isinstance(server, dict):
            continue
        overrides.extend(_codex_mcp_server_overrides(str(name), server))
    if overrides:
        logger.info("Injected Codex global MCP servers: count=%s", len(overrides))
    return tuple(overrides)


def _codex_mcp_server_overrides(name: str, server: dict[str, Any]) -> list[str]:
    key = _toml_key_path("mcp_servers", name)
    server_type = str(server.get("type") or "").strip()

    if server_type == "stdio" or server.get("command"):
        command = str(server.get("command") or "").strip()
        if not command:
            logger.warning("Skipping Codex stdio MCP without command: %s", name)
            return []
        overrides = [f"{key}.command={_toml_value(command)}"]
        args = server.get("args")
        if isinstance(args, list):
            overrides.append(f"{key}.args={_toml_value([str(arg) for arg in args])}")
        env = server.get("env")
        if isinstance(env, dict):
            for env_key, env_value in sorted(env.items()):
                if env_value is None:
                    continue
                overrides.append(
                    f"{key}.env.{_toml_key_segment(str(env_key))}="
                    f"{_toml_value(str(env_value))}"
                )
        return overrides

    url = str(server.get("url") or server.get("base_url") or "").strip()
    if not url:
        logger.warning("Skipping Codex URL MCP without URL: %s", name)
        return []

    overrides = [f"{key}.url={_toml_value(url)}"]
    bearer_env = server.get("bearer_token_env_var") or server.get("bearerTokenEnvVar")
    if bearer_env:
        overrides.append(f"{key}.bearer_token_env_var={_toml_value(str(bearer_env))}")
    oauth_client_id = server.get("oauth_client_id") or server.get("oauthClientId")
    if oauth_client_id:
        overrides.append(f"{key}.oauth_client_id={_toml_value(str(oauth_client_id))}")
    oauth_resource = server.get("oauth_resource") or server.get("oauthResource")
    if oauth_resource:
        overrides.append(f"{key}.oauth_resource={_toml_value(str(oauth_resource))}")
    return overrides


def _toml_key_path(*segments: str) -> str:
    return ".".join(_toml_key_segment(segment) for segment in segments)


def _toml_key_segment(segment: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]+", segment):
        return segment
    return json.dumps(segment)


def _toml_value(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_toml_value(item) for item in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value))


def _normalize_reasoning(value: Any) -> dict[str, str]:
    if isinstance(value, str):
        effort = value
        summary = None
    elif isinstance(value, dict):
        effort = value.get("effort") or value.get("reasoning")
        summary = value.get("summary")
        if isinstance(effort, dict):
            summary = summary or effort.get("summary")
            effort = effort.get("effort") or effort.get("reasoning")
    else:
        return {"effort": DEFAULT_REASONING_EFFORT}

    effort_value = _normalize_reasoning_effort(effort)
    result: dict[str, str] = {"effort": effort_value}
    if summary:
        summary_value = str(summary).lower()
        if summary_value in CODEX_REASONING_SUMMARIES:
            result["summary"] = summary_value
    return result


def _normalize_reasoning_effort(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    aliased = REASONING_EFFORT_ALIASES.get(normalized, normalized)
    if aliased in CODEX_REASONING_EFFORTS and aliased != "none":
        return aliased
    return DEFAULT_REASONING_EFFORT


def _normalize_service_tier(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        value = value.get("value") or value.get("speed") or value.get("service_tier")
    if not value:
        return None
    return SERVICE_TIER_ALIASES.get(str(value).strip().lower())
