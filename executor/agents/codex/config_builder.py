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

logger = setup_logger("codex_config_builder")


@dataclass(frozen=True)
class CodeXConfig:
    """Resolved Codex SDK configuration for one task run."""

    codex_bin: str
    model: str
    model_provider: str
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
    reasoning = _normalize_reasoning(model_config.get("reasoning"))

    overrides = [
        "forced_login_method=api",
        f"model={model}",
        f"model_provider={model_provider}",
        f"model_providers.{model_provider}.name={_resolve_provider_name(model_config)}",
        f"model_providers.{model_provider}.base_url={base_url.rstrip('/')}",
        f"model_providers.{model_provider}.wire_api={wire_api}",
        f"model_providers.{model_provider}.experimental_bearer_token={api_key}",
    ]

    thread_config: dict[str, Any] = {}
    if reasoning.get("effort"):
        thread_config["model_reasoning_effort"] = reasoning["effort"]
    if reasoning.get("summary"):
        thread_config["model_reasoning_summary"] = reasoning["summary"]

    return CodeXConfig(
        codex_bin=_resolve_codex_binary(config.CODEX_BINARY_PATH),
        model=model,
        model_provider=model_provider,
        config_overrides=tuple(overrides),
        thread_config=thread_config,
        effort=reasoning.get("effort"),
        summary=reasoning.get("summary"),
    )


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
        return {}

    result: dict[str, str] = {}
    if effort:
        effort_value = str(effort).lower()
        if effort_value in CODEX_REASONING_EFFORTS:
            result["effort"] = effort_value
    if summary:
        summary_value = str(summary).lower()
        if summary_value in CODEX_REASONING_SUMMARIES:
            result["summary"] = summary_value
    return result
