# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework HTTP clients share the desktop's authorized cloud model catalog."""

import pytest
from fastapi import HTTPException

from app.schemas.wework_api import WeworkResponseCreate
from app.services.model_aggregation_service import (
    kind_service,
    model_aggregation_service,
    public_model_service,
)
from app.services.wework_api import models


@pytest.fixture
def cloud_models(monkeypatch):
    monkeypatch.setattr(kind_service, "list_resources", lambda **kwargs: [])
    monkeypatch.setattr(
        model_aggregation_service,
        "_get_shell_support_model",
        lambda *args: ([], "Codex"),
    )
    entries = [
        {
            "name": "responses-model",
            "provider": "openai",
            "config": {"protocol": "openai-responses"},
        },
        {
            "name": "internal-anthropic",
            "provider": "claude",
            "config": {"api_key": "private-model-key"},
        },
        {
            "name": "internal-chat-completions",
            "provider": "openai",
            "config": {"apiFormat": "chat/completions"},
        },
        {"name": "disabled-for-wework", "is_wework_available": False},
        {"name": "embedding", "model_category_type": "embedding"},
    ]
    entries = [
        {
            "provider": "openai",
            "config": {},
            "model_category_type": "llm",
            "is_wework_available": True,
            **entry,
        }
        for entry in entries
    ]
    monkeypatch.setattr(public_model_service, "get_models", lambda **kwargs: entries)


def test_api_catalog_matches_desktop_without_native_shell_protocol_filter(
    test_db, test_user, cloud_models
):
    desktop = model_aggregation_service.list_available_models(
        db=test_db,
        current_user=test_user,
        scope="all",
        include_config=True,
        model_category_type="llm",
        client_origin="wework",
    )

    result = models.list_models(test_db, test_user)

    assert [item["id"] for item in result["data"]] == [
        models.model_identifier(item) for item in desktop
    ]
    assert {item["name"] for item in result["data"]} == {
        "responses-model",
        "internal-anthropic",
        "internal-chat-completions",
    }
    assert "private-model-key" not in str(result)
    assert all("config" not in item for item in result["data"])


@pytest.mark.parametrize("name", ["internal-anthropic", "internal-chat-completions"])
def test_api_can_select_gateway_models_by_the_returned_identifier(
    test_db, test_user, cloud_models, name
):
    body = WeworkResponseCreate(
        model=f"public:default:0:{name}", input="continue", conversation="conv_existing"
    )

    selection = models.selection(test_db, test_user, body)

    assert selection.model_name == name
    assert selection.model_type == "public"
    assert selection.options == {
        "weworkCloudModelNamespace": "default",
        "weworkCloudModelResourceUserId": 0,
    }


@pytest.mark.parametrize("name", ["disabled-for-wework", "embedding"])
def test_api_still_rejects_models_outside_wework_catalog(
    test_db, test_user, cloud_models, name
):
    body = WeworkResponseCreate(
        model=f"public:default:0:{name}", input="continue", conversation="conv_existing"
    )
    with pytest.raises(HTTPException) as error:
        models.selection(test_db, test_user, body)
    assert error.value.status_code == 422
