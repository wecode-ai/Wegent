# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.services.adapters.public_model import ModelAdapter


def test_public_model_adapter_forwards_model_capabilities():
    model = Kind(
        id=1,
        user_id=0,
        kind="Model",
        name="public-video-model",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": "public-video-model",
                "namespace": "default",
                "displayName": "Public Video Model",
            },
            "spec": {
                "modelType": "llm",
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "api_key": "secret",
                        "base_url": "https://example.com/v1",
                        "model_id": "qwen3.6-plus",
                    }
                },
                "modelCapabilities": {"supportsVideo": True},
            },
            "status": {"state": "Available"},
        },
    )

    result = ModelAdapter.to_model_dict(model)

    assert result["config"]["modelCapabilities"] == {"supportsVideo": True}
    assert result["config"]["env"] == {}
    assert result["provider"] == "openai"
    assert result["model_id"] == "qwen3.6-plus"
