#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import re
import shutil
from dataclasses import dataclass
from typing import Any, Optional

from executor.agents.env_value import resolve_env_value
from executor.config import config
from shared.logger import setup_logger

OPENAI_RESPONSES_PROTOCOL = "openai-responses"
RESPONSES_WIRE_API = "responses"
DEFAULT_PROVIDER_NAME = "wecode openai"
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


def build_codex_config(model_config: dict[str, Any]) -> CodeXConfig:
    """Build Codex SDK launch and thread parameters from Wegent model config."""
    model = str(model_config.get("model_id") or "").strip()
    if not model:
        raise ValueError("CodeXAgent requires model_config.model_id")

    local_config = _use_user_runtime_config(model_config, "codex")
    reasoning = _normalize_reasoning(model_config.get("reasoning"))
    service_tier = _normalize_service_tier(model_config.get("service_tier"))
    if local_config:
        overrides = [f"model={model}"]
        return CodeXConfig(
            codex_bin=_resolve_codex_binary(config.CODEX_BINARY_PATH),
            model=model,
            model_provider=None,
            config_overrides=tuple(overrides),
            thread_config=_build_thread_config(reasoning, service_tier),
            effort=reasoning.get("effort"),
            summary=reasoning.get("summary"),
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

    overrides = [
        "forced_login_method=api",
        f"model={model}",
        f"model_provider={model_provider}",
        f"model_providers.{model_provider}.name={_resolve_provider_name(model_config)}",
        f"model_providers.{model_provider}.base_url={base_url.rstrip('/')}",
        f"model_providers.{model_provider}.wire_api={wire_api}",
        f"model_providers.{model_provider}.experimental_bearer_token={api_key}",
    ]

    return CodeXConfig(
        codex_bin=_resolve_codex_binary(config.CODEX_BINARY_PATH),
        model=model,
        model_provider=model_provider,
        config_overrides=tuple(overrides),
        thread_config=_build_thread_config(reasoning, service_tier),
        effort=reasoning.get("effort"),
        summary=reasoning.get("summary"),
    )


def _use_user_runtime_config(model_config: dict[str, Any], runtime: str) -> bool:
    runtime_configs = model_config.get("runtime_config") or model_config.get(
        "runtimeConfig"
    )
    if not isinstance(runtime_configs, dict):
        return False

    runtime_config = runtime_configs.get(runtime)
    if not isinstance(runtime_config, dict):
        return False

    return bool(
        runtime_config.get("use_user_config") and runtime_config.get("configured", True)
    )


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
    return shutil.which(value) or value


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
