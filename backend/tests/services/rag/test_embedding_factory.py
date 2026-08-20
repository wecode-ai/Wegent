# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.rag.embedding.factory import create_embedding_model_from_crd


def test_create_embedding_model_from_crd_preserves_output_configuration() -> None:
    db = MagicMock()
    model_kind = SimpleNamespace(
        json={
            "spec": {
                "modelType": "embedding",
                "protocol": "custom",
                "modelConfig": {
                    "env": {
                        "base_url": "https://api.example.com/v1/embeddings",
                        "model_id": "Qwen/Qwen3-Embedding-8B",
                    }
                },
                "embeddingConfig": {
                    "dimensions": 1024,
                    "encoding_format": "float",
                },
            }
        }
    )
    db.query.return_value.filter.return_value.filter.return_value.order_by.return_value.first.return_value = (
        model_kind
    )
    embedding_model = SimpleNamespace()

    with patch(
        "app.services.rag.embedding.factory.engine_create_embedding_model_from_runtime_config",
        return_value=embedding_model,
    ) as create_runtime_model:
        result = create_embedding_model_from_crd(
            db=db,
            user_id=7,
            model_name="qwen-embedding",
        )

    assert result is embedding_model
    runtime_config = create_runtime_model.call_args.args[0]
    assert runtime_config.resolved_config["dimensions"] == 1024
    assert runtime_config.resolved_config["encoding_format"] == "float"
