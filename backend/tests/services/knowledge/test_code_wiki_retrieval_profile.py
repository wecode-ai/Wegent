"""Contract tests for knowledge-base retrieval-profile validation."""

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.schemas.knowledge import KnowledgeBaseRetrievalProfileUpdate
from app.services.knowledge.retrieval_profile import profile_health


class _Query:
    def __init__(self, resources: list[SimpleNamespace]) -> None:
        self.resources = resources

    def filter(self, *conditions: object) -> "_Query":
        return self

    def all(self) -> list[SimpleNamespace]:
        return self.resources


class _Db:
    def __init__(self, resources: list[SimpleNamespace]) -> None:
        self.resources = resources
        self.query_count = 0

    def query(self, model: object) -> _Query:
        self.query_count += 1
        return _Query(self.resources)


def test_profile_requires_complete_resource_references() -> None:
    with pytest.raises(
        ValidationError, match="requires a retriever and embedding model"
    ):
        KnowledgeBaseRetrievalProfileUpdate.model_validate(
            {"retrieval_config": {"retrieval_mode": "hybrid"}}
        )


def test_profile_accepts_complete_retrieval_configuration() -> None:
    profile = KnowledgeBaseRetrievalProfileUpdate.model_validate(
        {
            "retrieval_config": {
                "retriever_name": "shared-milvus",
                "retriever_namespace": "default",
                "embedding_config": {
                    "model_name": "shared-embedding",
                    "model_namespace": "default",
                },
                "retrieval_mode": "hybrid",
                "hybrid_weights": {"vector_weight": 0.6, "keyword_weight": 0.4},
            }
        }
    )

    assert profile.retrieval_config.retrieval_mode == "hybrid"


def test_profile_rejects_unsupported_retrieval_mode() -> None:
    with pytest.raises(ValidationError, match="unsupported retrieval mode"):
        KnowledgeBaseRetrievalProfileUpdate.model_validate(
            {
                "retrieval_config": {
                    "retriever_name": "shared-milvus",
                    "embedding_config": {"model_name": "shared-embedding"},
                    "retrieval_mode": "unsupported",
                }
            }
        )


def test_profile_health_loads_both_references_in_one_query() -> None:
    db = _Db(
        [
            SimpleNamespace(
                kind="Retriever",
                name="shared-milvus",
                namespace="default",
                json={},
            ),
            SimpleNamespace(
                kind="Model",
                name="shared-embedding",
                namespace="default",
                json={"spec": {"modelType": "embedding"}},
            ),
        ]
    )

    health = profile_health(
        db,  # type: ignore[arg-type]
        {
            "retriever_name": "shared-milvus",
            "retriever_namespace": "default",
            "embedding_config": {
                "model_name": "shared-embedding",
                "model_namespace": "default",
            },
        },
    )

    assert health == {"status": "valid", "fallback_reason": None}
    assert db.query_count == 1


def test_profile_health_rejects_incomplete_stored_profile_without_query() -> None:
    db = _Db([])

    health = profile_health(
        db,  # type: ignore[arg-type]
        {"retriever_name": "shared-milvus"},
    )

    assert health == {"status": "invalid", "fallback_reason": "profile_incomplete"}
    assert db.query_count == 0
