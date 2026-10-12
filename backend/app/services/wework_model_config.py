# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Non-secret Model CRD settings shared by Wework catalogs and execution."""

from typing import Any

REASONING_VALUES = {
    "effort": {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"},
    "summary": {"auto", "concise", "detailed"},
}
CODEX_REQUEST_MODES = {"auto", "standard", "passthrough"}


def wework_model_catalog_config(model_config: dict[str, Any]) -> dict[str, Any]:
    """Omit invalid request modes from catalog metadata without changing the CRD."""
    mode = model_config.get("codex_request_mode")
    config = dict(model_config)
    if not isinstance(mode, str) or mode not in CODEX_REQUEST_MODES:
        config.pop("codex_request_mode", None)
    config.update(wework_model_config_options(config))
    return config


def wework_model_config_options(
    model_config: Any, *, upstream_api_format: str | None = None
) -> dict[str, Any]:
    """Extract only supported reasoning and request policy fields."""
    if not isinstance(model_config, dict):
        return {}
    env = model_config.get("env")
    env = env if isinstance(env, dict) else {}
    thinking = env.get("thinking_config") or env.get("thinkingConfig")
    reasoning = thinking.get("reasoning") if isinstance(thinking, dict) else None
    options: dict[str, Any] = {}
    if isinstance(reasoning, dict):
        safe_reasoning = {
            key: value.strip().lower()
            for key, allowed in REASONING_VALUES.items()
            if isinstance(value := reasoning.get(key), str)
            and value.strip().lower() in allowed
        }
        if safe_reasoning:
            options["reasoning"] = safe_reasoning

    mode = model_config.get("codex_request_mode")
    if mode is not None:
        if not isinstance(mode, str) or mode not in CODEX_REQUEST_MODES:
            raise ValueError("codex_request_mode must be auto, standard or passthrough")
        if (
            mode == "passthrough"
            and upstream_api_format is not None
            and upstream_api_format != "openai-responses"
        ):
            raise ValueError("Codex passthrough requires an OpenAI Responses model")
        options["codex_request_mode"] = mode
    for key, alias in (
        ("native_tool_search", "nativeToolSearch"),
        ("native_namespace_tools", "nativeNamespaceTools"),
    ):
        for source in (model_config, env):
            value = source.get(key, source.get(alias))
            if isinstance(value, bool):
                options[key] = value
                break
        if mode in {"standard", "passthrough"}:
            options[key] = mode == "passthrough"
    return options


def merge_model_reasoning(
    model_config: dict[str, Any], selected: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Apply selected reasoning fields over the configured model defaults."""
    defaults = model_config.get("reasoning")
    if isinstance(defaults, dict) and isinstance(defaults.get("reasoning"), dict):
        defaults = defaults["reasoning"]
    reasoning = dict(defaults) if isinstance(defaults, dict) else {}
    reasoning.update(selected or {})
    return reasoning or None
