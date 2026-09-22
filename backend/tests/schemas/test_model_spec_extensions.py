# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.endpoints.kind.common import validate_and_prepare_resource
from app.schemas.kind import Model


def _model_payload() -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Model",
        "metadata": {"name": "extensible-model", "namespace": "default"},
        "spec": {
            "modelConfig": {
                "env": {
                    "model": "openai",
                    "model_id": "custom-model",
                    "api_key": "secret",
                    "supports_developer_role": False,
                },
                "futureRuntime": {"enabled": False},
            },
            "modelType": "video",
            "videoConfig": {
                "duration": 5,
                "futureVideoOption": {"mode": "fast"},
                "capabilities": {"futureCapability": ["alpha"]},
            },
            "futureSpecOption": {"retries": 0},
        },
        "status": {"state": "Available"},
    }


def test_model_spec_preserves_unknown_top_level_and_nested_fields() -> None:
    validated = Model.model_validate(_model_payload()).model_dump(mode="json")

    assert validated["spec"]["futureSpecOption"] == {"retries": 0}
    assert validated["spec"]["modelConfig"]["futureRuntime"] == {"enabled": False}
    assert validated["spec"]["modelConfig"]["env"]["supports_developer_role"] is False
    assert validated["spec"]["videoConfig"]["futureVideoOption"] == {"mode": "fast"}
    assert validated["spec"]["videoConfig"]["capabilities"]["futureCapability"] == [
        "alpha"
    ]


def test_kind_validation_preserves_model_spec_extensions() -> None:
    validated = validate_and_prepare_resource(
        "Model", _model_payload(), "default", "extensible-model"
    )

    assert validated["spec"]["futureSpecOption"] == {"retries": 0}
    assert validated["spec"]["videoConfig"]["futureVideoOption"] == {"mode": "fast"}


def test_known_model_fields_keep_their_validation() -> None:
    payload = _model_payload()
    payload["spec"]["modelType"] = "tts"
    payload["spec"]["ttsConfig"] = {"speed": 9}

    with pytest.raises(ValidationError, match="less than or equal to 4"):
        Model.model_validate(payload)


def test_model_spec_rejects_unsafe_keys_recursively_without_values() -> None:
    payload = _model_payload()
    payload["spec"]["modelConfig"]["env"]["nested"] = {
        "constructor": {"api_key": "must-not-appear"}
    }

    with pytest.raises(ValidationError) as exc_info:
        Model.model_validate(payload)

    message = str(exc_info.value)
    assert "spec.modelConfig.env.nested.constructor" in message
    assert "must-not-appear" not in message

    with pytest.raises(HTTPException) as http_exc_info:
        validate_and_prepare_resource("Model", payload, "default")
    assert "must-not-appear" not in str(http_exc_info.value.detail)
