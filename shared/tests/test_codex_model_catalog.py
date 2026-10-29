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


def test_resolves_exact_upstream_model() -> None:
    assert (
        codex_catalog_model_id_for_upstream(" DeepSeek-V4-Pro ")
        == "wework-deepseek-v4-pro"
    )


def test_resolves_declared_upstream_model_fragment() -> None:
    assert (
        codex_catalog_model_id_for_upstream("moonshot-kimi-k2.7-code-highspeed")
        == "wework-kimi-k2-7"
    )


def test_resolves_kimi_k3_1_pro() -> None:
    assert (
        codex_catalog_model_id_for_upstream("moonshot-kimi-k3.1-pro")
        == "wework-kimi-k3-1-pro"
    )
    assert (
        codex_catalog_model_id_for_upstream("moonshot-kimi-k3.1-pro-highspeed")
        == "wework-kimi-k3-1-pro"
    )


def test_resolves_kimi_k3() -> None:
    assert codex_catalog_model_id_for_upstream("moonshot-kimi-k3") == "wework-kimi-k3"
    assert codex_catalog_model_id_for_upstream("k3") == "wework-kimi-k3"


def test_resolves_active_wework_long_context_models() -> None:
    cases = [
        ("deepseek-v4.1-flash", "wework-deepseek-v4-1-flash"),
        ("huoshan-deepseek-v4.1-flash", "wework-deepseek-v4-1-flash"),
        ("thudm-glm-5.3", "wework-glm-5-3"),
        ("thudm-glm-5.3-flash", "wework-glm-5-3"),
        ("qwen3.8-max", "wework-qwen-3-8-max"),
        ("gpt-6-luna", "wework-gpt-6-luna"),
        ("gpt-6.1-sol", "wework-gpt-6.1-sol"),
        ("gpt-6-astra", "wework-gpt-6-astra"),
    ]
    for model_id, catalog_id in cases:
        assert codex_catalog_model_id_for_upstream(model_id) == catalog_id


def test_resolves_deepseek_flash_without_version_prefix() -> None:
    assert (
        codex_catalog_model_id_for_upstream("deepseek-flash")
        == "wework-deepseek-v4-flash"
    )
    assert (
        codex_catalog_model_id_for_upstream(" DeepSeek-Flash ")
        == "wework-deepseek-v4-flash"
    )


def test_returns_none_for_unregistered_upstream_model() -> None:
    assert codex_catalog_model_id_for_upstream("unregistered-model") is None
