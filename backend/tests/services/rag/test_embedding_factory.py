# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.rag.embedding.factory import create_embedding_model_from_crd
from shared.models.db import Kind
from shared.testing import capability_reference_database


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


def test_create_embedding_model_from_crd_resolves_shared_model_reference() -> None:
    with capability_reference_database() as database:
        source = Kind(
            id=101,
            user_id=42,
            kind="Model",
            name="shared-embedding",
            namespace="default",
            json={
                "spec": {
                    "modelType": "embedding",
                    "protocol": "custom",
                    "modelConfig": {
                        "env": {
                            "base_url": "https://api.example.com/v1/embeddings",
                            "model_id": "approved-source-model-id",
                        }
                    },
                }
            },
            is_active=True,
        )
        database.session.add(source)
        database.session.execute(
            database.namespace.insert().values(
                id=7,
                name="search-team",
                is_active=True,
            )
        )
        database.session.execute(
            database.resource_members.insert().values(
                id=1,
                resource_type="Model",
                resource_id=source.id,
                entity_type="namespace",
                entity_id="7",
                status="approved",
            )
        )
        database.session.commit()
        embedding_model = SimpleNamespace()

        with patch(
            "app.services.rag.embedding.factory.engine_create_embedding_model_from_runtime_config",
            return_value=embedding_model,
        ) as create_runtime_model:
            result = create_embedding_model_from_crd(
                db=database.session,
                user_id=99,
                model_name="shared-embedding",
                model_namespace="search-team",
            )

    runtime_config = create_runtime_model.call_args.args[0]
    assert (
        result,
        runtime_config.resolved_config["model_id"],
    ) == (embedding_model, "approved-source-model-id")
