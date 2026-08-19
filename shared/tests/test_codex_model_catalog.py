# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.codex_model_catalog import (
    codex_catalog_model_id_for_upstream,
    codex_catalog_model_id_from_config,
)


def test_catalog_id_config_candidates_are_validated_independently() -> None:
    blank_primary_result = codex_catalog_model_id_from_config(
        {
            "codex_catalog_model_id": "  ",
            "codexCatalogModelId": " operator-catalog ",
        }
    )
    non_string_primary_result = codex_catalog_model_id_from_config(
        {
            "codex_catalog_model_id": {"invalid": True},
            "codexCatalogModelId": "alias-catalog",
        }
    )

    assert blank_primary_result == "operator-catalog"
    assert non_string_primary_result == "alias-catalog"


def test_resolves_exact_upstream_model_with_matching_api_format() -> None:
    assert (
        codex_catalog_model_id_for_upstream(" DeepSeek-V4-Pro ", "openai-responses")
        == "wework-deepseek-v4-pro"
    )


def test_rejects_exact_upstream_model_with_incompatible_api_format() -> None:
    assert (
        codex_catalog_model_id_for_upstream(
            "deepseek-v4-pro", "openai-chat-completions"
        )
        is None
    )


def test_resolves_declared_upstream_model_fragment() -> None:
    assert (
        codex_catalog_model_id_for_upstream(
            "moonshot-kimi-k2.7-code-highspeed", "openai-responses"
        )
        == "wework-kimi-k2-7"
    )
    assert (
        codex_catalog_model_id_for_upstream(
            "moonshot-kimi-k2.7-code-highspeed", "anthropic-messages"
        )
        == "wework-kimi-k2-7"
    )


def test_resolves_declared_provider_specific_model_alias() -> None:
    assert (
        codex_catalog_model_id_for_upstream("k3", "openai-chat-completions")
        == "wework-kimi-k3"
    )
    assert (
        codex_catalog_model_id_for_upstream(
            "kimi-for-coding", "openai-chat-completions"
        )
        == "wework-kimi-k2-7"
    )


def test_returns_none_for_unregistered_upstream_model() -> None:
    assert (
        codex_catalog_model_id_for_upstream("unregistered-model", "openai-responses")
        is None
    )
