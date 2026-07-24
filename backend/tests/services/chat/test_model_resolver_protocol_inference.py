# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.chat.config.model_resolver import _extract_model_config


def _make_spec(
    *,
    env_model: str = "openai",
    protocol: str | None = None,
    api_format: str | None = None,
) -> dict:
    spec: dict = {
        "modelConfig": {
            "env": {
                "model": env_model,
                "model_id": "gpt-test",
                "api_key": "sk-test",
            }
        }
    }
    if protocol is not None:
        spec["protocol"] = protocol
    if api_format is not None:
        spec["apiFormat"] = api_format
    return spec


def test_extract_model_config_uses_spec_protocol_and_api_format():
    spec = _make_spec(env_model="openai", protocol="openai-responses")
    config = _extract_model_config(spec)

    assert config["protocol"] == "openai-responses"
    assert config["api_format"] == "responses"


def test_extract_model_config_falls_back_to_model_config_protocol_and_api_format():
    spec = {
        "modelConfig": {
            "env": {
                "model": "openai",
                "model_id": "gpt-test",
                "api_key": "sk-test",
            },
            "protocol": "openai",
            "apiFormat": "chat/completions",
        }
    }
    config = _extract_model_config(spec)

    assert config["protocol"] == "openai"
    assert config["api_format"] == "chat/completions"


def test_extract_model_config_infers_openai_chat_completions_from_env_model():
    spec = _make_spec(env_model="openai", protocol=None, api_format=None)
    config = _extract_model_config(spec)

    assert config["protocol"] == "openai"
    assert config["api_format"] == "chat/completions"


def test_extract_model_config_infers_claude_from_env_model():
    spec = _make_spec(env_model="claude", protocol=None, api_format=None)
    config = _extract_model_config(spec)

    assert config["protocol"] == "claude"
    assert config["api_format"] is None


def test_extract_model_config_preserves_explicit_api_format():
    spec = _make_spec(env_model="openai", protocol="openai", api_format="responses")
    config = _extract_model_config(spec)

    assert config["protocol"] == "openai"
    assert config["api_format"] == "responses"


def test_extract_model_config_does_not_infer_without_env_model():
    spec = {"modelConfig": {"env": {"model_id": "gpt-test", "api_key": "sk-test"}}}
    config = _extract_model_config(spec)

    assert config["protocol"] is None
    assert config["api_format"] is None
