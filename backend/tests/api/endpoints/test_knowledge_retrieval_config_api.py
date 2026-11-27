# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.api.endpoints.knowledge import _dump_retrieval_config_for_api
from app.models.kind import Kind
from app.models.user import User
from app.schemas.knowledge import RetrievalConfigCreate, RetrievalConfigUpdate
from tests.utils.namespace_members import add_group_member, group_namespace
from tests.utils.retrieval_resources import embedding_model_kind, model_kind
from tests.utils.retrieval_resources import retriever_kind as _retriever_kind


def _create_knowledge_base(test_client, test_token: str, retrieval_config: dict):
    return test_client.post(
        "/api/knowledge-bases",
        json={"name": "config-contract-kb", "retrieval_config": retrieval_config},
        headers={"Authorization": f"Bearer {test_token}"},
    )


@pytest.mark.api
def test_create_persists_guided_questions_and_call_limits(
    test_client, test_token
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    settings = {
        "guided_questions": ["Where is the handbook?"],
        "max_calls_per_conversation": 8,
        "exempt_calls_before_check": 2,
    }
    response = test_client.post(
        "/api/knowledge-bases",
        json={"name": "call-limits-kb", "rag_config_mode": "disabled", **settings},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    created = response.json()
    assert {key: created[key] for key in settings} == settings

    detail = test_client.get(f"/api/knowledge-bases/{created['id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    persisted = detail.json()
    assert {key: persisted[key] for key in settings} == settings


@pytest.mark.api
def test_create_rejects_exempt_calls_equal_to_default_maximum(
    test_client, test_token
) -> None:
    response = test_client.post(
        "/api/knowledge-bases",
        json={
            "name": "invalid-call-limits-kb",
            "rag_config_mode": "disabled",
            "exempt_calls_before_check": 10,
        },
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == 400, response.text


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
            "top_k": 50,
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["retrieval_config"]["retriever_name"] == "chosen-retriever"
    assert response.json()["retrieval_config"]["top_k"] == 50


@pytest.mark.api
def test_retrieval_top_k_defaults_and_update_bounds(
    test_client, test_token: str, test_db, test_user: User
) -> None:
    test_db.add_all(
        [
            _retriever_kind(test_user.id, "chosen-retriever"),
            embedding_model_kind(test_user.id, "chosen-embedding"),
        ]
    )
    test_db.commit()
    config = {
        "retriever_name": "chosen-retriever",
        "embedding_config": {"model_name": "chosen-embedding"},
    }

    invalid = _create_knowledge_base(test_client, test_token, {**config, "top_k": 51})
    assert invalid.status_code == 422, invalid.text
    assert invalid.json()["errors"][0]["loc"] == ["body", "retrieval_config", "top_k"]

    response = _create_knowledge_base(test_client, test_token, config)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["retrieval_config"]["top_k"] == 5

    url = f"/api/knowledge-bases/{created['id']}"
    headers = {"Authorization": f"Bearer {test_token}"}
    updated = test_client.put(
        url, json={"retrieval_config": {"top_k": 50}}, headers=headers
    )
    assert updated.status_code == 200, updated.text

    invalid = test_client.put(
        url, json={"retrieval_config": {"top_k": 51}}, headers=headers
    )
    assert invalid.status_code == 422, invalid.text
    assert invalid.json()["errors"][0]["loc"] == ["body", "retrieval_config", "top_k"]

    detail = test_client.get(url, headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["retrieval_config"]["top_k"] == 50


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


@pytest.mark.api
def test_create_rejects_a_group_embedding_model_the_caller_cannot_use(
    test_client, test_token: str, test_db, test_user: User
) -> None:
    """A personal knowledge base cannot borrow another group's embedding model."""
    group = group_namespace(
        test_db, "config-foreign-group", owner_user_id=test_user.id + 1000
    )
    test_db.add_all(
        [
            _retriever_kind(test_user.id, "chosen-retriever"),
            model_kind(test_user.id + 1000, "group-embedding", "embedding", group.name),
        ]
    )
    test_db.commit()

    response = _create_knowledge_base(
        test_client,
        test_token,
        {
            "retriever_name": "chosen-retriever",
            "embedding_config": {
                "model_name": "group-embedding",
                "model_namespace": group.name,
            },
        },
    )

    assert response.status_code == 400, response.text
    assert "group-embedding" in response.json()["detail"]


@pytest.mark.api
def test_create_accepts_a_group_embedding_model_for_group_members(
    test_client, test_token: str, test_db, test_user: User
) -> None:
    group = group_namespace(
        test_db, "config-member-group", owner_user_id=test_user.id + 1000
    )
    add_group_member(test_db, group, test_user)
    test_db.add_all(
        [
            _retriever_kind(test_user.id, "chosen-retriever"),
            model_kind(test_user.id + 1000, "group-embedding", "embedding", group.name),
        ]
    )
    test_db.commit()

    response = _create_knowledge_base(
        test_client,
        test_token,
        {
            "retriever_name": "chosen-retriever",
            "embedding_config": {
                "model_name": "group-embedding",
                "model_namespace": group.name,
            },
        },
    )

    assert response.status_code == 201, response.text
    assert (
        response.json()["retrieval_config"]["embedding_config"]["model_namespace"]
        == group.name
    )
