# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.api.endpoints.knowledge import _dump_retrieval_config_for_api
from app.models.kind import Kind
from app.models.user import User
from app.schemas.knowledge import RetrievalConfigCreate, RetrievalConfigUpdate
from tests.utils.retrieval_resources import embedding_model_kind, model_kind
from tests.utils.retrieval_resources import retriever_kind as _retriever_kind


def _create_knowledge_base(test_client, test_token: str, retrieval_config: dict):
    return test_client.post(
        "/api/knowledge-bases",
        json={"name": "config-contract-kb", "retrieval_config": retrieval_config},
        headers={"Authorization": f"Bearer {test_token}"},
    )


@pytest.mark.unit
def test_dump_create_retrieval_config_preserves_explicit_fields_only() -> None:
    config = RetrievalConfigCreate(retriever_name="retriever-1")

    payload = _dump_retrieval_config_for_api(config)

    assert payload == {"retriever_name": "retriever-1"}


@pytest.mark.unit
def test_dump_update_retrieval_config_preserves_explicit_fields_only() -> None:
    config = RetrievalConfigUpdate(top_k=8)

    payload = _dump_retrieval_config_for_api(config)

    assert payload == {"top_k": 8}


@pytest.mark.unit
def test_dump_retrieval_config_keeps_explicit_retrieval_mode() -> None:
    config = RetrievalConfigCreate(retrieval_mode="vector")

    payload = _dump_retrieval_config_for_api(config)

    assert payload == {"retrieval_mode": "vector"}


@pytest.mark.api
def test_create_accepts_resolvable_explicit_references(
    test_client, test_token: str, test_db, test_user: User
) -> None:
    test_db.add_all(
        [
            _retriever_kind(test_user.id, "chosen-retriever"),
            embedding_model_kind(test_user.id, "chosen-embedding"),
        ]
    )
    test_db.commit()

    response = _create_knowledge_base(
        test_client,
        test_token,
        {
            "retriever_name": "chosen-retriever",
            "embedding_config": {"model_name": "chosen-embedding"},
            "top_k": 4,
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["retrieval_config"]["retriever_name"] == "chosen-retriever"
    assert response.json()["retrieval_config"]["top_k"] == 4


@pytest.mark.api
def test_create_rejects_a_retriever_the_caller_cannot_use(
    test_client, test_token: str, test_db
) -> None:
    response = _create_knowledge_base(
        test_client,
        test_token,
        {
            "retriever_name": "not-mine",
            "embedding_config": {"model_name": "whatever"},
        },
    )

    assert response.status_code == 400, response.text
    assert "not-mine" in response.json()["detail"]
    assert test_db.query(Kind).filter(Kind.name == "config-contract-kb").count() == 0


@pytest.mark.api
def test_create_rejects_a_non_embedding_model_reference(
    test_client, test_token: str, test_db, test_user: User
) -> None:
    test_db.add_all(
        [
            _retriever_kind(test_user.id, "chosen-retriever"),
            model_kind(test_user.id, "chat-model", "llm"),
        ]
    )
    test_db.commit()

    response = _create_knowledge_base(
        test_client,
        test_token,
        {
            "retriever_name": "chosen-retriever",
            "embedding_config": {"model_name": "chat-model"},
        },
    )

    assert response.status_code == 400, response.text
    assert "chat-model" in response.json()["detail"]
