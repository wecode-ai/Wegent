# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public retrieval executes the retriever and embedding the caller named.

Regression cover for the gap where ``/api/rag/retrieve`` accepted explicit
``retriever_ref`` and ``embedding_model_ref`` values but the remote request
dropped them, so knowledge_runtime executed the knowledge base's stored
resources instead.
"""

from __future__ import annotations

import httpx
import pytest

from app.core.config import settings
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.services.rag.local_gateway import LocalRagGateway
from tests.utils.retrieval_resources import embedding_model_kind
from tests.utils.retrieval_resources import retriever_kind as build_retriever_kind

_STORED_CONFIG = {
    "retriever_name": "retriever-a",
    "retriever_namespace": "default",
    "embedding_config": {"model_name": "embed-a", "model_namespace": "default"},
}


@pytest.fixture(autouse=True)
def configure_remote_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", {"query": "remote"})
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def _create_knowledge_base(db, *, owner_user_id: int) -> Kind:
    kb = Kind(
        user_id=owner_user_id,
        kind="KnowledgeBase",
        name="public-query-kb",
        namespace="default",
        json={
            "spec": {
                "name": "public-query-kb",
                "retrievalConfig": dict(_STORED_CONFIG),
            }
        },
        is_active=True,
    )
    db.add(kb)
    db.commit()
    db.refresh(kb)
    return kb


def _create_resource_pair(db, owner_user_id: int, suffix: str) -> None:
    db.add(build_retriever_kind(owner_user_id, f"retriever-{suffix}"))
    db.add(embedding_model_kind(owner_user_id, f"embed-{suffix}"))
    db.commit()


def _payload(knowledge_id: int, *, retriever: str, embedding: str) -> dict:
    return {
        "query": "release checklist",
        "knowledge_id": str(knowledge_id),
        "retriever_ref": {"name": retriever, "namespace": "default"},
        "embedding_model_ref": {
            "model_name": embedding,
            "model_namespace": "default",
        },
        "top_k": 5,
        "score_threshold": 0.7,
        "retrieval_mode": "vector",
    }


def _runtime_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "records": [
                {
                    "content": "release checklist",
                    "title": "Checklist",
                    "score": 0.9,
                    "metadata": {"source": "kb"},
                }
            ],
            "total": 1,
            "total_estimated_tokens": 3,
        },
        request=httpx.Request("POST", "http://knowledge-runtime/internal/rag/query"),
    )


def test_public_retrieve_executes_caller_selected_resources(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """The named retriever and embedding reach knowledge_runtime, not stored ones."""
    _create_resource_pair(test_db, test_user.id, "a")
    _create_resource_pair(test_db, test_user.id, "b")
    kb = _create_knowledge_base(test_db, owner_user_id=test_user.id)
    local_query = mocker.patch.object(
        LocalRagGateway,
        "query",
        side_effect=AssertionError("local must not be used for remote queries"),
    )
    post = mocker.patch("httpx.AsyncClient.post", return_value=_runtime_response())

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="retriever-b", embedding="embed-b"),
    )

    assert response.status_code == 200
    assert response.json() == {
        "records": [
            {
                "content": "release checklist",
                "score": 0.9,
                "title": "Checklist",
                "metadata": {"source": "kb"},
            }
        ]
    }
    assert post.await_args.args[0] == (
        f"{settings.KNOWLEDGE_RUNTIME_URL}/internal/rag/query"
    )
    body = post.await_args.kwargs["json"]
    assert body["authorized_resources"] == [
        {
            "knowledge_base_id": kb.id,
            "index_owner_user_id": test_user.id,
            "retriever": {
                "kind": "Retriever",
                "name": "retriever-b",
                "namespace": "default",
            },
            "embedding_model": {
                "kind": "Model",
                "name": "embed-b",
                "namespace": "default",
            },
            "explicit_selection": True,
        }
    ]
    assert "explicit_resources" not in body
    local_query.assert_not_called()


def test_public_retrieve_authorizes_an_approved_shared_retriever(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """A Retriever referenced into the owner's scope reaches the runtime."""
    source_owner = User(
        user_name="retriever-owner",
        password_hash="unused",
        email="retriever-owner@example.com",
        is_active=True,
    )
    test_db.add(source_owner)
    test_db.add(embedding_model_kind(test_user.id, "embed-a"))
    test_db.commit()
    test_db.refresh(source_owner)
    shared_retriever = build_retriever_kind(source_owner.id, "shared-retriever")
    test_db.add(shared_retriever)
    test_db.commit()
    test_db.refresh(shared_retriever)
    test_db.add(
        ResourceMember.create(
            resource_type="Retriever",
            resource_id=shared_retriever.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role="Reporter",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=source_owner.id,
        )
    )
    kb = _create_knowledge_base(test_db, owner_user_id=test_user.id)
    post = mocker.patch("httpx.AsyncClient.post", return_value=_runtime_response())

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="shared-retriever", embedding="embed-a"),
    )

    assert response.status_code == 200
    body = post.await_args.kwargs["json"]
    assert body["authorized_resources"] == [
        {
            "knowledge_base_id": kb.id,
            "index_owner_user_id": test_user.id,
            "retriever": {
                "kind": "Retriever",
                "name": "shared-retriever",
                "namespace": "default",
            },
            "embedding_model": {
                "kind": "Model",
                "name": "embed-a",
                "namespace": "default",
            },
            "explicit_selection": True,
        }
    ]


def test_public_retrieve_rejects_unavailable_explicit_resource(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """A resource the knowledge base owner cannot use is refused."""
    _create_resource_pair(test_db, test_user.id, "a")
    kb = _create_knowledge_base(test_db, owner_user_id=test_user.id)
    post = mocker.patch("httpx.AsyncClient.post")

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="missing-retriever", embedding="embed-a"),
    )

    assert response.status_code == 403
    assert "missing-retriever" in response.json()["detail"]
    post.assert_not_called()


def test_public_retrieve_rejects_unapproved_shared_retriever(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """A pending capability reference is not an authorized Retriever."""
    source_owner = User(
        user_name="pending-retriever-owner",
        password_hash="unused",
        email="pending-retriever-owner@example.com",
        is_active=True,
    )
    test_db.add(source_owner)
    test_db.add(embedding_model_kind(test_user.id, "embed-a"))
    test_db.commit()
    test_db.refresh(source_owner)
    shared_retriever = build_retriever_kind(source_owner.id, "shared-retriever")
    test_db.add(shared_retriever)
    test_db.commit()
    test_db.refresh(shared_retriever)
    test_db.add(
        ResourceMember.create(
            resource_type="Retriever",
            resource_id=shared_retriever.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role="Reporter",
            status=MemberStatus.PENDING.value,
            invited_by_user_id=source_owner.id,
        )
    )
    kb = _create_knowledge_base(test_db, owner_user_id=test_user.id)
    post = mocker.patch("httpx.AsyncClient.post")

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="shared-retriever", embedding="embed-a"),
    )

    assert response.status_code == 403
    assert "shared-retriever" in response.json()["detail"]
    post.assert_not_called()


def test_public_retrieve_rejects_inactive_explicit_resource(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """A disabled resource cannot be executed through an explicit reference."""
    _create_resource_pair(test_db, test_user.id, "a")
    kb = _create_knowledge_base(test_db, owner_user_id=test_user.id)
    test_db.query(Kind).filter(
        Kind.kind == "Retriever",
        Kind.name == "retriever-a",
        Kind.user_id == test_user.id,
    ).update({"is_active": False})
    test_db.commit()
    post = mocker.patch("httpx.AsyncClient.post")

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="retriever-a", embedding="embed-a"),
    )

    assert response.status_code == 403
    assert "retriever-a" in response.json()["detail"]
    post.assert_not_called()


def test_public_retrieve_rejects_unreadable_knowledge_base(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """A caller without knowledge base access is refused before any query."""
    owner = User(
        user_name="kb-owner",
        password_hash="unused",
        email="owner@example.com",
        is_active=True,
    )
    test_db.add(owner)
    test_db.commit()
    test_db.refresh(owner)
    _create_resource_pair(test_db, owner.id, "a")
    kb = _create_knowledge_base(test_db, owner_user_id=owner.id)
    post = mocker.patch("httpx.AsyncClient.post")

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="retriever-a", embedding="embed-a"),
    )

    assert response.status_code == 400
    assert "access denied" in response.json()["detail"]
    post.assert_not_called()


def test_public_retrieve_rejects_non_embedding_model(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """A model without embedding capability cannot fill the embedding slot."""
    _create_resource_pair(test_db, test_user.id, "a")
    test_db.add(
        Kind(
            user_id=test_user.id,
            kind="Model",
            name="chat-model",
            namespace="default",
            json={"spec": {"modelType": "chat"}},
            is_active=True,
        )
    )
    kb = _create_knowledge_base(test_db, owner_user_id=test_user.id)
    test_db.commit()
    post = mocker.patch("httpx.AsyncClient.post")

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="retriever-a", embedding="chat-model"),
    )

    assert response.status_code == 403
    assert "chat-model" in response.json()["detail"]
    post.assert_not_called()


def test_public_retrieve_exposes_remote_failure_without_local_fallback(
    test_client,
    test_db,
    test_user: User,
    test_token: str,
    mocker,
) -> None:
    """A retryable remote failure is surfaced instead of retried locally."""
    _create_resource_pair(test_db, test_user.id, "a")
    kb = _create_knowledge_base(test_db, owner_user_id=test_user.id)
    mocker.patch(
        "httpx.AsyncClient.post",
        return_value=httpx.Response(
            503,
            json={
                "code": "runtime_unavailable",
                "message": "knowledge runtime unavailable",
                "retryable": True,
            },
            request=httpx.Request(
                "POST", "http://knowledge-runtime/internal/rag/query"
            ),
        ),
    )
    local_query = mocker.patch.object(
        LocalRagGateway,
        "query",
        side_effect=AssertionError("local must not be used as a rollback path"),
    )

    response = test_client.post(
        "/api/rag/retrieve",
        headers={"Authorization": f"Bearer {test_token}"},
        json=_payload(kb.id, retriever="retriever-a", embedding="embed-a"),
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "knowledge runtime unavailable"
    local_query.assert_not_called()
