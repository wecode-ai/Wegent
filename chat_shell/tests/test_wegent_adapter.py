# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from chat_shell.adapters.wegent import WeGentToResponseAdapter


def test_build_model_config_preserves_model_identity_from_agent_config() -> None:
    model_config = WeGentToResponseAdapter._build_model_config(
        {
            "model_name": "main-model",
            "model_namespace": "team-a",
            "model": "gpt-4.1",
            "model_type": "openai",
        }
    )

    assert model_config["model_name"] == "main-model"
    assert model_config["model_namespace"] == "team-a"


def test_build_model_config_prefers_model_spec_identity() -> None:
    model_config = WeGentToResponseAdapter._build_model_config(
        {
            "model_name": "fallback-model",
            "model_namespace": "default",
            "model_spec": {
                "model_name": "resolved-model",
                "model_namespace": "group-a",
            },
        }
    )

    assert model_config["model_name"] == "resolved-model"
    assert model_config["model_namespace"] == "group-a"


def test_build_model_config_falls_through_none_identity_values() -> None:
    model_config = WeGentToResponseAdapter._build_model_config(
        {
            "model_name": None,
            "model_namespace": None,
            "model": {
                "model_name": "nested-model",
                "model_namespace": "group-b",
            },
        }
    )

    assert model_config["model_name"] == "nested-model"
    assert model_config["model_namespace"] == "group-b"
