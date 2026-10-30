# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.chat.trigger.request_preparation import (
    _build_codex_runtime_model_config,
    build_wework_runtime_model_config,
)
from tests.services.test_llm_proxy_service import _model_kind


def test_build_codex_runtime_model_config_returns_provider_credentials(
    test_db: Session, test_user: User
):
    model = _model_kind(test_user.id)
    test_db.add(model)
    test_db.commit()
    config = _build_codex_runtime_model_config(
        model.name,
        db=test_db,
        user_id=test_user.id,
    )

    assert config["model_id"] == "gpt-4-turbo"
    assert config["base_url"] == "https://api.example.com/v1"
    assert config["api_key"] == "sk-test-key"
    assert config["upstream_api_format"] == "openai-responses"
    assert "codex_responses_compat_proxy" not in config


@pytest.mark.parametrize(
    ("protocol", "api_format", "env_model"),
    [
        ("openai", None, None),
        ("claude", None, None),
        ("openai-responses", "chat/completions", None),
        ("openai-responses", "messages", None),
        (None, None, "openai"),
        (None, None, "claude"),
    ],
)
def test_direct_runtime_rejects_passthrough_for_other_protocols(
    test_db: Session,
    test_user: User,
    protocol: str | None,
    api_format: str | None,
    env_model: str | None,
) -> None:
    """Reject incompatible explicit and inferred wire formats before dispatch."""
    model = _model_kind(
        test_user.id,
        protocol=protocol,
        api_format=api_format,
        env_model=env_model,
    )
    model.json["spec"]["modelConfig"]["codex_request_mode"] = "passthrough"
    test_db.add(model)
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        _build_codex_runtime_model_config(model.name, db=test_db, user_id=test_user.id)

    assert error.value.status_code == 400
    assert "Responses" in error.value.detail


@pytest.mark.parametrize(
    ("protocol", "api_format"), [("openai-responses", None), (None, "responses")]
)
def test_direct_runtime_preserves_responses_passthrough(
    test_db: Session,
    test_user: User,
    protocol: str | None,
    api_format: str | None,
) -> None:
    """Keep valid direct Responses requests in passthrough mode."""
    model = _model_kind(test_user.id, protocol=protocol, api_format=api_format)
    model.json["spec"]["modelConfig"]["codex_request_mode"] = "passthrough"
    test_db.add(model)
    test_db.commit()

    config = _build_codex_runtime_model_config(
        model.name, db=test_db, user_id=test_user.id
    )

    assert config["codex_request_mode"] == "passthrough"
    assert config["upstream_api_format"] == "openai-responses"


@pytest.mark.parametrize(
    ("model_id", "expected_catalog_model_id"),
    [
        ("deepseek-v4-flash", "wework-deepseek-v4-flash"),
        ("deepseek-v4-pro", "wework-deepseek-v4-pro"),
    ],
)
def test_build_codex_runtime_model_config_infers_deepseek_responses_catalog(
    test_db: Session,
    test_user: User,
    model_id: str,
    expected_catalog_model_id: str,
) -> None:
    model = _model_kind(
        test_user.id,
        name=f"{model_id}-profile",
        model_id=model_id,
    )
    test_db.add(model)
    test_db.commit()

    config = _build_codex_runtime_model_config(
        model.name,
        db=test_db,
        user_id=test_user.id,
    )

    assert config["codex_catalog_model_id"] == expected_catalog_model_id


def test_kimi_k3_1_pro_responses_uses_its_own_catalog_and_token_limits(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings

    model = _model_kind(
        0,
        name="moonshot-kimi-k3.1-pro",
        model_id="moonshot-kimi-k3.1-pro",
        protocol="openai-responses",
    )
    model.json["spec"]["modelConfig"]["context_window"] = 1_048_576
    model.json["spec"]["modelConfig"]["max_output_tokens"] = 96_000
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")

    direct = _build_codex_runtime_model_config(
        model.name,
        db=test_db,
        user_id=test_user.id,
    )
    assert direct["codex_catalog_model_id"] == "wework-kimi-k3-1-pro"

    expanded = build_wework_runtime_model_config(
        test_db, model_name=model.name, creator=test_user
    )
    assert expanded["codex_catalog_model_id"] == "wework-kimi-k3-1-pro"
    assert expanded["model_context_window"] == 1_048_576
    assert expanded["max_output_tokens"] == 96_000


def test_build_codex_runtime_model_config_infers_deepseek_chat_catalog(
    test_db: Session,
    test_user: User,
) -> None:
    model = _model_kind(
        test_user.id,
        name="deepseek-chat-profile",
        model_id="deepseek-v4-pro",
        protocol="openai",
    )
    test_db.add(model)
    test_db.commit()

    config = _build_codex_runtime_model_config(
        model.name,
        db=test_db,
        user_id=test_user.id,
    )

    assert config["codex_catalog_model_id"] == "wework-deepseek-v4-pro"


def test_build_codex_runtime_model_config_preserves_explicit_catalog(
    test_db: Session,
    test_user: User,
) -> None:
    model = _model_kind(
        test_user.id,
        name="deepseek-explicit-profile",
        model_id="deepseek-v4-pro",
    )
    test_db.add(model)
    test_db.commit()

    config = _build_codex_runtime_model_config(
        model.name,
        {"codex_catalog_model_id": "operator-selected-catalog"},
        db=test_db,
        user_id=test_user.id,
    )

    assert config["codex_catalog_model_id"] == "operator-selected-catalog"


@pytest.mark.parametrize(
    ("protocol", "api_format", "expected"),
    [
        ("openai-responses", None, "openai-responses"),
        ("openai", "responses", "openai-responses"),
        ("openai", None, "openai-chat-completions"),
        ("openai-chat-completions", None, "openai-chat-completions"),
        ("claude", None, "anthropic-messages"),
        ("anthropic-messages", None, "anthropic-messages"),
    ],
)
@pytest.mark.parametrize("client_protocol", [None, "openai-responses"])
def test_cloud_runtime_protocol_comes_from_model_crd(
    test_db, test_user, monkeypatch, protocol, api_format, expected, client_protocol
):
    from app.core.config import settings
    from app.services.runtime_work_service import _runtime_model_override_values

    model = _model_kind(0, protocol=protocol, api_format=api_format)
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")
    options = {
        "weworkCloudModelNamespace": "default",
        "weworkCloudModelResourceUserId": "0",
    }
    if client_protocol is not None:
        options["weworkCloudModelUpstreamApiFormat"] = client_protocol

    config, _, _ = _runtime_model_override_values(
        db=test_db,
        user_id=test_user.id,
        runtime="codex",
        model_id=model.name,
        model_type="public",
        model_options=options,
    )
    legacy_config = build_wework_runtime_model_config(
        test_db, model_name=model.name, creator=test_user
    )

    for resolved in (config, legacy_config):
        assert resolved["upstream_api_format"] == expected
        assert resolved["model_id"] == model.name
        assert resolved["protocol"] == "openai-responses"
        assert resolved["api_key"] and resolved["api_key"] != "sk-test-key"
        assert "sk-test-key" not in json.dumps(resolved)
        assert resolved["base_url"] == (
            "https://wegent.example/api/runtime-work/llm-responses-proxy"
        )
        assert resolved["default_headers"]["X-Wegent-Model-User-Id"] == "0"
    assert config["native_tool_search"] is (expected == "openai-responses")
    assert config["native_namespace_tools"] is (expected == "openai-responses")
    assert config["tool_profile"] == "custom"


def test_cloud_runtime_can_bridge_standard_responses_tools(
    test_db, test_user, monkeypatch
):
    from app.core.config import settings
    from app.services.runtime_work_service import _runtime_model_override_values

    model = _model_kind(0, protocol="openai-responses")
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")

    config, _, _ = _runtime_model_override_values(
        db=test_db,
        user_id=test_user.id,
        runtime="codex",
        model_id=model.name,
        model_type="public",
        model_options={
            "weworkCloudModelNamespace": "default",
            "weworkCloudModelResourceUserId": "0",
            "weworkCloudModelUpstreamApiFormat": "openai-responses",
            "weworkCloudModelNativeToolSearch": "false",
            "weworkCloudModelNativeNamespaceTools": "false",
        },
    )

    assert config["native_tool_search"] is False
    assert config["native_namespace_tools"] is False


@pytest.mark.parametrize("mode", ["auto", "standard", "passthrough"])
@pytest.mark.parametrize("reasoning", [{"effort": "high"}, {"summary": "detailed"}])
def test_cloud_runtime_preserves_model_reasoning_and_request_policy(
    test_db, test_user, monkeypatch, mode, reasoning
) -> None:
    from app.core.config import settings
    from app.services.runtime_work_service import _runtime_model_override_values

    model = _model_kind(0, protocol="openai-responses")
    model.json["spec"]["modelConfig"]["codex_request_mode"] = mode
    model.json["spec"]["modelConfig"]["env"]["thinking_config"] = {
        "reasoning": reasoning
    }
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")

    config, _, _ = _runtime_model_override_values(
        db=test_db,
        user_id=test_user.id,
        runtime="codex",
        model_id=model.name,
        model_type="public",
        model_options={
            "weworkCloudModelNamespace": "default",
            "weworkCloudModelResourceUserId": "0",
            "weworkCloudModelNativeToolSearch": "true",
        },
    )
    legacy = build_wework_runtime_model_config(
        test_db, model_name=model.name, creator=test_user
    )
    for resolved in (config, legacy):
        assert resolved["reasoning"] == reasoning
        assert resolved["codex_request_mode"] == mode
        assert "sk-test-key" not in json.dumps(resolved)
        if mode != "auto":
            assert resolved["native_tool_search"] is (mode == "passthrough")
            assert resolved["native_namespace_tools"] is (mode == "passthrough")


def test_cloud_runtime_rejects_passthrough_for_other_protocols(
    test_db, test_user, monkeypatch
) -> None:
    from app.core.config import settings

    model = _model_kind(0, protocol="openai")
    model.json["spec"]["modelConfig"]["codex_request_mode"] = "passthrough"
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")

    with pytest.raises(HTTPException, match="OpenAI Responses"):
        build_wework_runtime_model_config(
            test_db, model_name=model.name, creator=test_user
        )


@pytest.mark.parametrize("resource_user_id", [0, -1])
def test_runtime_rejects_invalid_request_policy_without_provider_fallback(
    test_db, test_user, monkeypatch, resource_user_id
) -> None:
    from app.core.config import settings

    owner = test_user.id if resource_user_id == -1 else resource_user_id
    model = _model_kind(owner)
    model.json["spec"]["modelConfig"]["codex_request_mode"] = "invalid"
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")
    with pytest.raises(HTTPException) as exc_info:
        build_wework_runtime_model_config(
            test_db, model_name=model.name, creator=test_user
        )
    assert exc_info.value.status_code == 400


@pytest.mark.parametrize(
    ("protocol", "api_format"),
    [(None, None), ("claude", "responses"), ("openai-responses", "chat/completions")],
)
def test_cloud_runtime_rejects_invalid_protocol_before_dispatch(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    protocol: str | None,
    api_format: str | None,
) -> None:
    from app.core.config import settings
    from app.services.chat.trigger.request_preparation import (
        _build_cloud_gateway_model_config,
    )

    model = _model_kind(0, protocol=protocol, api_format=api_format)
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")

    with pytest.raises(HTTPException) as exc_info:
        _build_cloud_gateway_model_config(
            test_db,
            model_name=model.name,
            creator=test_user,
            model_type="public",
            namespace="default",
            resource_user_id=0,
        )

    assert exc_info.value.status_code == 400
    assert "protocol/apiFormat" in exc_info.value.detail


def test_build_wework_runtime_model_config_preserves_explicit_cloud_catalog(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings

    model = _model_kind(
        0,
        name="deepseek-public-profile",
        model_id="deepseek-v4-pro",
    )
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(
        settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://wegent.example.com",
    )

    config = build_wework_runtime_model_config(
        test_db,
        model_name=model.name,
        creator=test_user,
        model_options={"codex_catalog_model_id": "operator-selected-catalog"},
    )

    assert config["model_id"] == model.name
    assert config["codex_catalog_model_id"] == "operator-selected-catalog"


@pytest.mark.parametrize(
    ("model_id", "catalog_id"),
    [
        ("gpt-6.1-sol", "wework-gpt-6.1-sol"),
        ("gpt-6-astra", "wework-gpt-6-astra"),
        ("unregistered-cloud-model", "wework-gpt-6.1-sol"),
    ],
)
@pytest.mark.parametrize("protocol", ["openai-responses", "openai", "claude"])
def test_cloud_models_use_wework_catalogs_without_official_account(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    model_id: str,
    catalog_id: str,
    protocol: str,
) -> None:
    from app.core.config import settings

    model = _model_kind(0, model_id=model_id, protocol=protocol)
    model.json["spec"]["modelConfig"].update(
        context_window=1_200_000, max_output_tokens=96_000
    )
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")

    config = build_wework_runtime_model_config(
        test_db, model_name=model.name, creator=test_user
    )

    assert config["codex_catalog_model_id"] == catalog_id
    assert config["model_context_window"] == 1_200_000
    assert config["max_output_tokens"] == 96_000
    assert config["base_url"].startswith("https://wegent.example/")
    assert "sk-test-key" not in json.dumps(config)
