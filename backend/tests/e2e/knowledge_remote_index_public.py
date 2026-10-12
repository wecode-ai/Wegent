# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public explicit-resource retrieval over the real remote data plane.

Each resource choice is proved independently: an unreachable saved Retriever
cannot answer via the explicit Retriever, and an unreachable saved Model cannot
embed via the explicit Model. No transport, gateway or runtime is mocked.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from contextlib import ExitStack

import httpx
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    QDRANT_URL,
    UNREACHABLE_EMBEDDING_URL,
    UNREACHABLE_QDRANT_URL,
    _assert_local_operations_are_refused,
    _assert_remote_gateways,
    _auth_headers,
    _check,
    _chunk_contents,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_document,
    _delete_knowledge_base,
    _document_chunks,
    _log,
    _point_retriever_at,
    _response_detail,
    _upload_attachment,
    _wait_for_index_status,
)

QueryCall = Callable[[str, str], httpx.Response]


def _public_retrieve(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    query: str,
    retriever: str,
    embedding: str,
) -> httpx.Response:
    return client.post(
        "/api/rag/retrieve",
        headers=_auth_headers(token),
        json={
            "knowledge_id": str(knowledge_base_id),
            "query": query,
            "retriever_ref": {"name": retriever, "namespace": "default"},
            "embedding_model_ref": {
                "model_name": embedding,
                "model_namespace": "default",
            },
            "top_k": 5,
            "score_threshold": 0.0,
            "retrieval_mode": "vector",
        },
    )


def _point_embedding_at(client: httpx.Client, token: str, name: str, url: str) -> None:
    """Change a real model through its CRD API, without replacing the runtime."""
    path = f"/api/v1/namespaces/default/models/{name}"
    current = client.get(path, headers=_auth_headers(token))
    _check(current.status_code == 200, f"reading the embedding failed: {current.text}")
    payload = current.json()
    payload["spec"]["modelConfig"]["env"]["base_url"] = url
    updated = client.put(path, headers=_auth_headers(token), json=payload)
    _check(updated.status_code == 200, f"updating the embedding failed: {updated.text}")


def _assert_hit(
    response: httpx.Response, marker: str, document_id: int, context: str
) -> None:
    _check(
        response.status_code == 200,
        f"{context}: {response.status_code} {response.text}",
    )
    records = response.json().get("records", [])
    _check(
        any(
            marker in record["content"]
            and (record.get("metadata") or {}).get("doc_ref") == str(document_id)
            for record in records
        ),
        f"{context} must retrieve the indexed document: {records}",
    )
    _log(context)


def _assert_remote_failure(response: httpx.Response, context: str) -> None:
    # A local gateway refusal is not evidence of a runtime failure. The runtime
    # hides connection internals behind this stable error, which Backend preserves.
    _check(
        response.status_code == 500
        and _response_detail(response) == "internal server error",
        f"{context} must expose the runtime failure: {response.status_code} {response.text}",
    )
    _log(f"{context}: remote status=500 detail=internal server error")


def _prove_independent_selection(
    client: httpx.Client,
    token: str,
    query: QueryCall,
    saved: str,
    selected: str,
    marker: str,
    document_id: int,
) -> None:
    _point_retriever_at(client, token, saved, UNREACHABLE_QDRANT_URL)
    try:
        _assert_remote_failure(query(saved, saved), "saved Retriever is unreachable")
        _assert_hit(
            query(selected, saved),
            marker,
            document_id,
            "explicit Retriever executes despite the unreachable saved Retriever",
        )
    finally:
        _point_retriever_at(client, token, saved, QDRANT_URL)
    _point_embedding_at(client, token, saved, UNREACHABLE_EMBEDDING_URL)
    try:
        _assert_remote_failure(query(saved, saved), "saved Embedding is unreachable")
        _assert_hit(
            query(saved, selected),
            marker,
            document_id,
            "explicit Embedding executes despite the unreachable saved Embedding",
        )
        _assert_hit(
            query(selected, selected),
            marker,
            document_id,
            "both explicit resources retrieve the document through the public entry",
        )
    finally:
        _point_embedding_at(client, token, saved, EMBEDDING_MODEL_URL)


def _prove_selected_failures(
    client: httpx.Client,
    token: str,
    query: QueryCall,
    saved: str,
    selected: str,
    marker: str,
    document_id: int,
) -> None:
    _point_retriever_at(client, token, selected, UNREACHABLE_QDRANT_URL)
    try:
        _assert_hit(
            query(saved, saved), marker, document_id, "saved resources remain queryable"
        )
        _assert_remote_failure(
            query(selected, selected), "explicit Retriever failure cannot fall back"
        )
    finally:
        _point_retriever_at(client, token, selected, QDRANT_URL)
    _point_embedding_at(client, token, selected, UNREACHABLE_EMBEDDING_URL)
    try:
        _assert_hit(
            query(saved, saved),
            marker,
            document_id,
            "saved Embedding remains queryable",
        )
        _assert_remote_failure(
            query(selected, selected), "explicit Embedding failure cannot fall back"
        )
    finally:
        _point_embedding_at(client, token, selected, EMBEDDING_MODEL_URL)


def _delete_created_resource(client: httpx.Client, token: str, path: str) -> None:
    response = client.delete(path, headers=_auth_headers(token))
    _check(
        response.status_code < 300, f"fixture cleanup failed: {path}: {response.text}"
    )


def _create_resources(
    stack: ExitStack,
    client: httpx.Client,
    token: str,
    name: str,
) -> None:
    def register(path: str) -> None:
        stack.callback(_delete_created_resource, client, token, path)

    _create_retrieval_resources(
        client, token, name, embedding_url=EMBEDDING_MODEL_URL, on_created=register
    )


def _delete_private_owner(user_id: int, name: str) -> None:
    # There is no public user deletion API; only this fixture user is removed.
    from app.db.session import SessionLocal
    from app.models.user import User

    with SessionLocal() as db:
        db.query(User).filter(User.id == user_id, User.user_name == name).delete()
        db.commit()


def _prove_private_resources_refused(
    client: httpx.Client,
    token: str,
    query: QueryCall,
    selected: str,
) -> None:
    """Another real user's existing private resources are outside the owner's set."""
    name = f"e2e-explicit-private-{uuid.uuid4().hex[:10]}"
    password = uuid.uuid4().hex
    created = client.post(
        "/api/users",
        headers=_auth_headers(token),
        json={"user_name": name, "password": password},
    )
    _check(
        created.status_code == 201, f"creating the private owner failed: {created.text}"
    )
    with ExitStack() as fixtures:
        fixtures.callback(_delete_private_owner, int(created.json()["id"]), name)
        login = client.post(
            "/api/auth/login", json={"user_name": name, "password": password}
        )
        _check(login.status_code == 200, "the private owner must log in")
        private_token = login.json()["access_token"]
        _create_resources(fixtures, client, private_token, name)
        for retriever, embedding in [(name, selected), (selected, name)]:
            refused = query(retriever, embedding)
            _check(
                refused.status_code == 403 and _response_detail(refused),
                f"private explicit references must be refused: {refused.status_code} {refused.text}",
            )
        _log("another owner's private Retriever and Embedding references are refused")


def _delete_unattached_content(attachment_id: int, owner_user_id: int) -> None:
    from app.db.session import SessionLocal
    from app.services.context import context_service

    with SessionLocal() as db:
        _check(
            context_service.delete_context(db, attachment_id, owner_user_id),
            "unattached fixture cleanup failed",
        )


def _create_indexed_fixture(
    stack: ExitStack,
    client: httpx.Client,
    token: str,
    owner_user_id: int,
    saved: str,
    suffix: str,
    marker: str,
) -> tuple[int, int, str]:
    kb = _create_knowledge_base(client, token, f"E2E-PUBLIC-{suffix}", saved)
    kb_id = int(kb["id"])
    stack.callback(_delete_knowledge_base, client, token, kb_id)
    with ExitStack() as unattached:
        attachment_id, _ = _upload_attachment(client, token, marker)
        unattached.callback(_delete_unattached_content, attachment_id, owner_user_id)
        document_id = int(_create_document(client, token, kb_id, attachment_id)["id"])
        stack.callback(_delete_document, client, token, document_id)
        # Document deletion now owns the attachment cleanup, including failures.
        unattached.pop_all()
    _wait_for_index_status(client, token, kb_id, document_id, "success")
    return (
        kb_id,
        document_id,
        _chunk_contents(_document_chunks(client, token, document_id)),
    )


def run_public_retrieval_scenario(
    client: httpx.Client,
    token: str,
    owner_user_id: int,
) -> None:
    """CI-invoked product-entry proof, independent of saved resource availability."""
    suffix = uuid.uuid4().hex[:10]
    saved, selected = f"e2e-public-saved-{suffix}", f"e2e-public-selected-{suffix}"
    marker = f"WEGENT-E2E-PUBLIC-EXPLICIT-{suffix}"
    with ExitStack() as fixtures:
        _create_resources(fixtures, client, token, saved)
        _create_resources(fixtures, client, token, selected)
        kb_id, document_id, content = _create_indexed_fixture(
            fixtures, client, token, owner_user_id, saved, suffix, marker
        )

        def query(retriever: str, embedding: str) -> httpx.Response:
            return _public_retrieve(client, token, kb_id, content, retriever, embedding)

        _assert_remote_gateways()
        _assert_local_operations_are_refused(kb_id, document_id, saved, owner_user_id)
        _assert_hit(
            query(saved, saved),
            marker,
            document_id,
            "public saved-resource control retrieves the document",
        )
        _prove_independent_selection(
            client, token, query, saved, selected, marker, document_id
        )
        _prove_private_resources_refused(client, token, query, selected)
        _prove_selected_failures(
            client, token, query, saved, selected, marker, document_id
        )
