from datetime import datetime
from types import SimpleNamespace

from app.schemas.knowledge import KnowledgeBaseResponse


def make_kind(retrieval_config):
    return SimpleNamespace(
        id=123,
        user_id=456,
        namespace="default",
        is_active=True,
        created_at=datetime(2026, 1, 1),
        updated_at=datetime(2026, 1, 2),
        json={
            "spec": {
                "name": "Test KB",
                "retrievalConfig": retrieval_config,
            }
        },
    )


def test_from_kind_keeps_complete_retrieval_config():
    response = KnowledgeBaseResponse.from_kind(
        make_kind(
            {
                "retriever_name": "duckdb",
                "retriever_namespace": "default",
                "embedding_config": {
                    "model_name": "text-embedding",
                    "model_namespace": "default",
                },
                "retrieval_mode": "vector",
                "top_k": 5,
                "score_threshold": 0.5,
            }
        )
    )

    assert response.retrieval_config is not None
    assert response.retrieval_config.retriever_name == "duckdb"
    assert response.retrieval_config.embedding_config.model_name == "text-embedding"


def test_from_kind_drops_retrieval_config_missing_retriever():
    response = KnowledgeBaseResponse.from_kind(
        make_kind(
            {
                "embedding_config": {
                    "model_name": "text-embedding",
                    "model_namespace": "default",
                },
                "retrieval_mode": "vector",
            }
        )
    )

    assert response.retrieval_config is None


def test_from_kind_drops_retrieval_config_missing_embedding_model():
    response = KnowledgeBaseResponse.from_kind(
        make_kind(
            {
                "retriever_name": "duckdb",
                "retriever_namespace": "default",
                "embedding_config": {"model_namespace": "default"},
                "retrieval_mode": "vector",
            }
        )
    )

    assert response.retrieval_config is None


def test_from_kind_drops_non_dict_retrieval_config():
    response = KnowledgeBaseResponse.from_kind(make_kind("legacy-invalid-config"))

    assert response.retrieval_config is None


def test_from_kind_drops_retrieval_config_with_non_dict_embedding_config():
    response = KnowledgeBaseResponse.from_kind(
        make_kind(
            {
                "retriever_name": "duckdb",
                "retriever_namespace": "default",
                "embedding_config": "legacy-invalid-embedding",
                "retrieval_mode": "vector",
            }
        )
    )

    assert response.retrieval_config is None
