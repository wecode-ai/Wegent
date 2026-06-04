# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.models.codex_routing import (
    is_codex_compatible_model_config,
    read_model_api_format,
    should_route_to_codex_agent,
    uses_responses_wire_api,
)


def test_read_model_api_format_supports_backend_and_frontend_keys():
    assert read_model_api_format({"api_format": "responses"}) == "responses"
    assert read_model_api_format({"apiFormat": "responses"}) == "responses"


def test_uses_responses_wire_api_accepts_supported_markers():
    assert uses_responses_wire_api({"api_format": "responses"})
    assert uses_responses_wire_api({"protocol": "openai-responses"})
    assert uses_responses_wire_api({"wire_api": "responses"})
    assert not uses_responses_wire_api({"api_format": "chat/completions"})


def test_is_codex_compatible_model_config_requires_openai_responses_model():
    assert is_codex_compatible_model_config(
        {"model": "openai", "api_format": "responses"}
    )
    assert not is_codex_compatible_model_config(
        {"model": "claude", "api_format": "responses"}
    )
    assert not is_codex_compatible_model_config(
        {"model": "openai", "api_format": "chat/completions"}
    )


def test_should_route_to_codex_agent_requires_codex_shell_or_claudecode_responses():
    gpt_responses_config = {"model": "openai", "protocol": "openai-responses"}

    assert should_route_to_codex_agent("ClaudeCode", gpt_responses_config)
    assert should_route_to_codex_agent("Codex", {"model": "claude"})
    assert not should_route_to_codex_agent("Chat", gpt_responses_config)
    assert not should_route_to_codex_agent(
        "ClaudeCode",
        {"model": "openai", "api_format": "chat/completions"},
    )
