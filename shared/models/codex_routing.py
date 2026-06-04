# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared routing helpers for requests that execute through CodeXAgent."""

from typing import Any

OPENAI_RESPONSES_PROTOCOL = "openai-responses"
RESPONSES_WIRE_API = "responses"


def read_model_api_format(model_config: dict[str, Any]) -> str:
    """Return a normalized model API format from supported config keys."""
    return str(
        model_config.get("api_format") or model_config.get("apiFormat") or ""
    ).lower()


def uses_responses_wire_api(model_config: dict[str, Any]) -> bool:
    """Return whether a model config declares OpenAI Responses wire API."""
    api_format = read_model_api_format(model_config)
    protocol = str(model_config.get("protocol") or "").lower()
    wire_api = str(model_config.get("wire_api") or "").lower()

    return (
        api_format == RESPONSES_WIRE_API
        or protocol == OPENAI_RESPONSES_PROTOCOL
        or wire_api == RESPONSES_WIRE_API
    )


def is_codex_compatible_model_config(model_config: dict[str, Any]) -> bool:
    """Return whether a model config is compatible with CodeXAgent routing."""
    provider = str(model_config.get("model") or "").lower()
    return provider == "openai" and uses_responses_wire_api(model_config)


def should_route_to_codex_agent(
    shell_type: str,
    model_config: dict[str, Any],
) -> bool:
    """Return whether a shell/model pair will execute through CodeXAgent."""
    normalized_shell_type = str(shell_type or "").strip().lower()
    if normalized_shell_type == "codex":
        return True
    return normalized_shell_type == "claudecode" and is_codex_compatible_model_config(
        model_config
    )
