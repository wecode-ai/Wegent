# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.services.wework_model_config import (
    merge_model_reasoning,
    wework_model_catalog_config,
    wework_model_config_options,
)


@pytest.mark.parametrize("thinking_key", ["thinking_config", "thinkingConfig"])
def test_exports_only_supported_non_secret_reasoning(thinking_key: str) -> None:
    config = {
        "env": {
            "api_key": "private-provider-key",
            thinking_key: {
                "reasoning": {
                    "effort": " HIGH ",
                    "summary": "detailed",
                    "token": "secret",
                },
                "headers": {"Authorization": "secret"},
            },
        }
    }

    assert wework_model_config_options(config) == {
        "reasoning": {"effort": "high", "summary": "detailed"}
    }


@pytest.mark.parametrize("mode", ["standard", "passthrough"])
def test_request_policy_overrides_individual_tool_flags(mode: str) -> None:
    assert wework_model_config_options(
        {"codex_request_mode": mode, "native_tool_search": True}
    ) == {
        "codex_request_mode": mode,
        "native_tool_search": mode == "passthrough",
        "native_namespace_tools": mode == "passthrough",
    }


@pytest.mark.parametrize(
    "config", [None, {}, {"env": []}, {"env": {"thinking_config": []}}]
)
def test_unconfigured_models_keep_existing_defaults(config: object) -> None:
    assert wework_model_config_options(config) == {}


def test_invalid_reasoning_is_not_exposed() -> None:
    assert (
        wework_model_config_options(
            {
                "env": {
                    "thinking_config": {
                        "reasoning": {"effort": "secret", "summary": []}
                    }
                }
            }
        )
        == {}
    )


@pytest.mark.parametrize("mode", ["unknown", True, {}])
def test_invalid_request_mode_is_rejected(mode: object) -> None:
    with pytest.raises(ValueError, match="codex_request_mode"):
        wework_model_config_options({"codex_request_mode": mode})


@pytest.mark.parametrize("mode", ["unknown", True, {}, []])
def test_catalog_omits_invalid_mode_without_mutating_execution_config(
    mode: object,
) -> None:
    """Catalog omission must not make an invalid execution configuration valid."""
    config = {
        "codex_request_mode": mode,
        "env": {"thinking_config": {"reasoning": {"effort": "high"}}},
    }
    catalog_config = wework_model_catalog_config(config)
    assert "codex_request_mode" not in catalog_config
    assert catalog_config["reasoning"] == {"effort": "high"}
    assert config["codex_request_mode"] == mode
    with pytest.raises(ValueError, match="codex_request_mode"):
        wework_model_config_options(config)


def test_existing_env_flags_preserve_false_values() -> None:
    assert wework_model_config_options(
        {"env": {"nativeToolSearch": False, "native_namespace_tools": False}}
    ) == {"native_tool_search": False, "native_namespace_tools": False}


def test_selected_effort_preserves_default_summary() -> None:
    config = {"reasoning": {"effort": "high", "summary": "detailed"}}
    assert merge_model_reasoning(config, {"effort": "low"}) == {
        "effort": "low",
        "summary": "detailed",
    }
    assert config["reasoning"]["effort"] == "high"


def test_runtime_dispatch_merges_selected_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.runtime_work_service import _apply_runtime_model_options

    monkeypatch.setattr(
        "app.services.chat.trigger.request_preparation._apply_user_runtime_config",
        lambda *args: None,
    )
    request = SimpleNamespace(
        model_config={"reasoning": {"effort": "high", "summary": "detailed"}}
    )
    payload = SimpleNamespace(model_options={"reasoning": "low"})
    _apply_runtime_model_options(None, request, None, payload)
    assert request.model_config["reasoning"] == {"effort": "low", "summary": "detailed"}
    assert request.reasoning_config == request.model_config["reasoning"]


def test_selected_reasoning_overrides_legacy_provider_wrapper() -> None:
    assert merge_model_reasoning(
        {"reasoning": {"reasoning": {"effort": "high", "summary": "detailed"}}},
        {"effort": "low"},
    ) == {"effort": "low", "summary": "detailed"}
