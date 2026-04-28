# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import patch

from app.core.config import settings


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _public_model(name: str, display_name: str) -> dict[str, object]:
    return {
        "name": name,
        "displayName": display_name,
        "provider": "openai",
        "model_id": name,
        "model_category_type": "llm",
        "is_advanced": False,
    }


def _recommended_model(name: str, display_name: str) -> dict[str, object]:
    return {
        "name": name,
        "type": "public",
        "displayName": display_name,
        "provider": "openai",
        "modelId": name,
        "modelCategoryType": "llm",
        "isAdvanced": False,
    }


def test_error_recommendations_include_default_errors_entry(
    test_client,
    test_token: str,
    monkeypatch,
):
    monkeypatch.setattr(
        settings,
        "ERROR_MODEL_RECOMMENDATIONS",
        json.dumps(
            {
                "rate_limit": {
                    "description": "Alternative models to avoid rate limits",
                    "models": ["gemini-2.5-pro", "missing-model"],
                },
                "default_errors": {
                    "description": "Fallback models for unmapped errors",
                    "models": ["claude-sonnet-4", "another-missing-model"],
                },
            }
        ),
    )

    with patch(
        "app.api.endpoints.adapter.models.public_model_service.get_models",
        return_value=[
            _public_model("gemini-2.5-pro", "Gemini 2.5 Pro"),
            _public_model("claude-sonnet-4", "Claude Sonnet 4"),
        ],
    ):
        response = test_client.get(
            "/api/models/error-recommendations",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json() == {
        "data": {
            "rate_limit": {
                "description": "Alternative models to avoid rate limits",
                "models": [_recommended_model("gemini-2.5-pro", "Gemini 2.5 Pro")],
            },
            "default_errors": {
                "description": "Fallback models for unmapped errors",
                "models": [_recommended_model("claude-sonnet-4", "Claude Sonnet 4")],
            },
        }
    }


def test_error_recommendations_preserve_explicit_empty_entries(
    test_client,
    test_token: str,
    monkeypatch,
):
    monkeypatch.setattr(
        settings,
        "ERROR_MODEL_RECOMMENDATIONS",
        json.dumps(
            {
                "unknown_error": {
                    "description": "Explicitly disable model recommendations",
                    "models": [],
                },
                "default_errors": {
                    "description": "Fallback models for unmapped errors",
                    "models": ["missing-model"],
                },
            }
        ),
    )

    with patch(
        "app.api.endpoints.adapter.models.public_model_service.get_models",
        return_value=[_public_model("gemini-2.5-pro", "Gemini 2.5 Pro")],
    ):
        response = test_client.get(
            "/api/models/error-recommendations",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json() == {
        "data": {
            "unknown_error": {
                "description": "Explicitly disable model recommendations",
                "models": [],
            },
            "default_errors": {
                "description": "Fallback models for unmapped errors",
                "models": [],
            },
        }
    }
