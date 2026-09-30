# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CI E2E coverage for plain-document indexing through the remote runtime.

The scenario drives the product entries end to end: the document
create/rebuild entries enqueue an indexing generation, the real Celery task
fetches the attachment content, ``knowledge_runtime`` resolves the index
configuration through the shared module and writes Qdrant, and a
document-scoped product query returns the knowledge base and document
references.

MySQL, Redis, object storage, the runtime process, and Qdrant are real. Only
the embedding HTTP endpoint is a deterministic mock. The remote data plane is
the only data plane: a runtime failure must stay visible, a stale indexing
generation must not overwrite the newer result, and local index/query calls
raise immediately while indexing and querying run remote.

Run from ``backend/`` after the CI services are up:

    uv run --no-sync python tests/e2e/knowledge_remote_index.py
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

import httpx

BACKEND_URL = os.environ.get("E2E_API_URL", "http://localhost:8000").rstrip("/")
KNOWLEDGE_RUNTIME_URL = os.environ.get(
    "E2E_KNOWLEDGE_RUNTIME_URL", "http://localhost:8200"
).rstrip("/")
QDRANT_URL = os.environ.get("E2E_QDRANT_URL", "http://localhost:6333").rstrip("/")
MOCK_MODEL_SERVER_URL = os.environ.get(
    "MOCK_MODEL_SERVER_URL", "http://localhost:9999"
).rstrip("/")
EMBEDDING_MODEL_URL = (
    os.environ.get("E2E_EMBEDDING_BASE_URL") or f"{MOCK_MODEL_SERVER_URL}/v1/embeddings"
)
INTERNAL_SERVICE_TOKEN = os.environ.get("E2E_INTERNAL_SERVICE_TOKEN") or os.environ.get(
    "INTERNAL_SERVICE_TOKEN", ""
)
ADMIN_USER_NAME = (
    os.environ.get("E2E_ADMIN_USER")
    or os.environ.get("E2E_BOOTSTRAP_ADMIN_USER")
    or "admin"
)
ADMIN_password = os.environ.get("E2E_ADMIN_PASSWORD") or os.environ.get(
    "E2E_BOOTSTRAP_ADMIN_PASSWORD", ""
)

EMBEDDING_DIMENSIONS = 32
INDEX_TIMEOUT_SECONDS = float(os.environ.get("E2E_INDEX_TIMEOUT_SECONDS", "120"))
UNREACHABLE_EMBEDDING_URL = "http://127.0.0.1:1/v1/embeddings"


class KnowledgeRemoteIndexE2EError(AssertionError):
    """Fail the scenario with a stable message."""


def _check(condition: object, message: str) -> None:
    if not condition:
        raise KnowledgeRemoteIndexE2EError(message)


def _log(message: str) -> None:
    print(f"[knowledge-remote-index-e2e] {message}", flush=True)


def _create_client() -> httpx.Client:
    return httpx.Client(base_url=BACKEND_URL, timeout=60.0)


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client: httpx.Client) -> tuple[str, int]:
    """Log the CI admin in, provisioning the bootstrap password on a fresh DB."""

    _check(ADMIN_password, "the E2E admin password env var is required")
    setup = client.post(
        "/api/auth/admin-password/setup", json={"password": ADMIN_password}
    )
    _check(
        setup.status_code in (200, 409),
        f"admin password setup failed: {setup.status_code} {setup.text}",
    )
    login = client.post(
        "/api/auth/login",
        json={"user_name": ADMIN_USER_NAME, "password": ADMIN_password},
    )
    _check(login.status_code == 200, f"login failed: {login.status_code} {login.text}")
    token = login.json().get("access_token")
    _check(token, "the login response did not include an access token")
    me = client.get("/api/users/me", headers=_auth_headers(token))
    _check(me.status_code == 200, f"reading the caller failed: {me.text}")
    return token, int(me.json()["id"])


def _require_remote_services() -> None:
    health = httpx.get(f"{KNOWLEDGE_RUNTIME_URL}/internal/rag/health", timeout=30.0)
    _check(
        health.status_code == 200,
        f"knowledge_runtime must be running: {health.status_code} {health.text}",
    )
    embedding = httpx.get(f"{MOCK_MODEL_SERVER_URL}/health", timeout=30.0)
    _check(
        embedding.status_code == 200,
        f"the mock embedding service must be running: {embedding.text}",
    )


def _create_retrieval_resources(
    client: httpx.Client, token: str, name: str, *, embedding_url: str
) -> None:
    """Create the real Retriever and Model records the knowledge base references."""

    headers = _auth_headers(token)
    connection = client.post(
        "/api/retrievers/test-connection",
        headers=headers,
        json={"storage_type": "qdrant", "url": QDRANT_URL},
    )
    _check(
        connection.status_code == 200 and connection.json().get("success") is True,
        f"Qdrant must be reachable through the retriever check: {connection.text}",
    )
    model = client.post(
        "/api/v1/namespaces/default/models",
        headers=headers,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "modelType": "embedding",
                "protocol": "custom",
                "embeddingConfig": {
                    "dimensions": EMBEDDING_DIMENSIONS,
                    "encoding_format": "float",
                },
                "modelConfig": {
                    "env": {
                        "model": "custom",
                        "model_id": "e2e-embedding",
                        "base_url": embedding_url,
                    }
                },
            },
        },
    )
    _check(
        model.status_code < 300, f"creating the embedding model failed: {model.text}"
    )
    retriever = client.post(
        "/api/retrievers",
        headers=headers,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Retriever",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "storageConfig": {
                    "type": "qdrant",
                    "url": QDRANT_URL,
                    "indexStrategy": {"mode": "per_dataset"},
                },
                "retrievalMethods": {"vector": {"enabled": True}},
            },
        },
    )
    _check(
        retriever.status_code < 300, f"creating the retriever failed: {retriever.text}"
    )


def _create_knowledge_base(
    client: httpx.Client, token: str, name: str, resource_name: str
) -> dict[str, Any]:
    response = client.post(
        "/api/knowledge-bases",
        headers=_auth_headers(token),
        json={
            "name": name,
            "description": "Plain-document remote index E2E",
            "namespace": "default",
            "kb_type": "classic",
            "rag_config_mode": "auto",
            "retrieval_config": {
                "retriever_name": resource_name,
                "retriever_namespace": "default",
                "embedding_config": {
                    "model_name": resource_name,
                    "model_namespace": "default",
                },
                "retrieval_mode": "vector",
                "top_k": 5,
                # The mock embedding is deterministic but not semantic, so keep the
                # scoped query deterministic instead of threshold-dependent.
                "score_threshold": 0.0,
            },
            "summary_enabled": False,
        },
    )
    _check(
        response.status_code < 300,
        f"creating the knowledge base failed: {response.text}",
    )
    knowledge_base = response.json()
    _check(
        knowledge_base.get("retrieval_config", {}).get("retriever_name")
        == resource_name,
        f"the knowledge base did not store the retrieval config: {knowledge_base}",
    )
    return knowledge_base


def _upload_attachment(
    client: httpx.Client, token: str, marker: str
) -> tuple[int, str]:
    content = f"# E2E plain document\n\n唯一断言标记：{marker}\n"
    response = client.post(
        "/api/attachments/upload",
        headers=_auth_headers(token),
        files={"file": ("release-notes.md", content.encode(), "text/markdown")},
    )
    _check(
        response.status_code == 200, f"uploading the attachment failed: {response.text}"
    )
    return int(response.json()["id"]), content


def _create_document(
    client: httpx.Client, token: str, knowledge_base_id: int, attachment_id: int
) -> dict[str, Any]:
    response = client.post(
        f"/api/knowledge-bases/{knowledge_base_id}/documents",
        headers=_auth_headers(token),
        json={
            "attachment_id": attachment_id,
            "name": "release-notes.md",
            "file_extension": "md",
            "folder_id": 0,
            "source_type": "file",
        },
    )
    _check(response.status_code < 300, f"creating the document failed: {response.text}")
    return response.json()


def _document_row(
    client: httpx.Client, token: str, knowledge_base_id: int, document_id: int
) -> dict[str, Any]:
    response = client.get(
        f"/api/knowledge-bases/{knowledge_base_id}/documents",
        headers=_auth_headers(token),
        params={"limit": 100, "offset": 0},
    )
    _check(response.status_code == 200, f"listing documents failed: {response.text}")
    for item in response.json().get("items", []):
        if int(item["id"]) == document_id:
            return item
    raise KnowledgeRemoteIndexE2EError(
        f"document {document_id} is missing from the list"
    )


def _wait_for_index_status(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    document_id: int,
    expected: str,
    *,
    generation: int | None = None,
) -> dict[str, Any]:
    deadline = time.monotonic() + INDEX_TIMEOUT_SECONDS
    latest: dict[str, Any] = {}
    while time.monotonic() < deadline:
        latest = _document_row(client, token, knowledge_base_id, document_id)
        if latest.get("index_status") == expected:
            if generation is not None:
                _check(
                    int(latest["index_generation"]) == generation,
                    f"document {document_id} reached {expected} in generation "
                    f"{latest.get('index_generation')}, expected {generation}",
                )
            return latest
        time.sleep(2)
    raise KnowledgeRemoteIndexE2EError(
        f"document {document_id} stayed in index_status={latest.get('index_status')} "
        f"(processing_error={latest.get('processing_error')}) instead of {expected}"
    )


def _document_chunks(
    client: httpx.Client, token: str, document_id: int
) -> list[dict[str, Any]]:
    response = client.get(
        f"/api/knowledge-documents/{document_id}/chunks",
        headers=_auth_headers(token),
        params={"page": 1, "page_size": 100},
    )
    _check(
        response.status_code == 200, f"reading document chunks failed: {response.text}"
    )
    return list(response.json().get("items", []))


def _chunk_contents(chunks: list[dict[str, Any]]) -> str:
    return "\n".join(str(chunk.get("content") or "") for chunk in chunks)


def _internal_retrieve(
    client: httpx.Client,
    knowledge_base_id: int,
    document_id: int,
    query: str,
    *,
    user_id: int,
) -> httpx.Response:
    _check(INTERNAL_SERVICE_TOKEN, "the internal service token is required")
    return client.post(
        "/api/internal/rag/retrieve",
        headers={"Authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}"},
        json={
            "query": query,
            "user_id": user_id,
            "knowledge_base_ids": [knowledge_base_id],
            "document_ids": [document_id],
            "route_mode": "rag_retrieval",
            "max_results": 5,
        },
    )


def _assert_records_reference_document(
    records: list[dict[str, Any]],
    knowledge_base_id: int,
    document_id: int,
    marker: str,
) -> None:
    _check(records, "expected at least one retrieval record")
    matching = [
        record
        for record in records
        if record.get("knowledge_base_id") == knowledge_base_id
        and record.get("document_id") == document_id
    ]
    _check(
        matching,
        f"records must reference knowledge base {knowledge_base_id} and document "
        f"{document_id}: {json.dumps(records, ensure_ascii=False)}",
    )
    _check(
        any(marker in (record.get("content") or "") for record in matching),
        "records must carry the indexed content "
        f"{marker}: {json.dumps(matching, ensure_ascii=False)}",
    )


def _runtime_query(
    knowledge_base_id: int,
    document_id: int,
    resource_name: str,
    owner_user_id: int,
    query: str,
) -> httpx.Response:
    """Query the runtime store directly, bypassing the Backend data plane."""

    _check(INTERNAL_SERVICE_TOKEN, "the internal service token is required")
    return httpx.post(
        f"{KNOWLEDGE_RUNTIME_URL}/internal/rag/query",
        headers={"Authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}"},
        timeout=60.0,
        json={
            "knowledge_base_ids": [knowledge_base_id],
            "user_id": owner_user_id,
            "query": query,
            "max_results": 5,
            "document_ids": [document_id],
            "authorized_resources": [
                {
                    "knowledge_base_id": knowledge_base_id,
                    "index_owner_user_id": owner_user_id,
                    "retriever": {
                        "kind": "Retriever",
                        "name": resource_name,
                        "namespace": "default",
                    },
                    "embedding_model": {
                        "kind": "Model",
                        "name": resource_name,
                        "namespace": "default",
                    },
                }
            ],
        },
    )


def _delete_document(client: httpx.Client, token: str, document_id: int) -> None:
    response = client.delete(
        f"/api/knowledge-documents/{document_id}", headers=_auth_headers(token)
    )
    _check(response.status_code < 300, f"deleting the document failed: {response.text}")


def _delete_knowledge_base(
    client: httpx.Client, token: str, knowledge_base_id: int
) -> None:
    response = client.delete(
        f"/api/knowledge-bases/{knowledge_base_id}", headers=_auth_headers(token)
    )
    _check(
        response.status_code < 300,
        f"deleting the knowledge base failed: {response.text}",
    )


def _delete_retrieval_resources(client: httpx.Client, token: str, name: str) -> None:
    headers = _auth_headers(token)
    retriever = client.delete(f"/api/retrievers/{name}", headers=headers)
    _check(
        retriever.status_code < 300, f"deleting the retriever failed: {retriever.text}"
    )
    model = client.delete(f"/api/v1/namespaces/default/models/{name}", headers=headers)
    _check(model.status_code < 300, f"deleting the model failed: {model.text}")


@contextmanager
def _local_data_plane_raises() -> Iterator[None]:
    """Any local index or query call performed inside this block fails."""

    from app.services.rag.local_gateway import LocalRagGateway

    originals: dict[str, Any] = {}
    for method in ("index_document", "query", "delete_document_index"):
        original = getattr(LocalRagGateway, method)
        originals[method] = original

        def _fail(*_args: Any, _method: str = method, **_kwargs: Any) -> Any:
            raise KnowledgeRemoteIndexE2EError(
                f"local data plane method {_method} must not run"
            )

        setattr(LocalRagGateway, method, _fail)
    try:
        yield
    finally:
        for method, original in originals.items():
            setattr(LocalRagGateway, method, original)


def _assert_remote_data_plane() -> None:
    """Index and query must resolve to the remote runtime, never the local plane."""

    from app.core.config import settings
    from app.services.rag.gateway_factory import get_query_gateway
    from app.services.rag.remote_gateway import RemoteRagGateway

    _check(
        settings.get_rag_runtime_mode("index") == "remote",
        "the Backend must index through the remote runtime in this environment",
    )
    _check(
        settings.get_rag_runtime_mode("query") == "remote",
        "the Backend must query through the remote runtime in this environment",
    )
    _check(
        isinstance(get_query_gateway(), RemoteRagGateway),
        "the query gateway must be the remote gateway",
    )


def _run_stale_generation_guard(
    knowledge_base_id: int,
    document_id: int,
    resource_name: str,
    owner_user_id: int,
    *,
    marker: str,
    stale_generation: int,
) -> None:
    """An older generation must stand down and leave the newest index intact."""

    from app.core.config import settings
    from app.db.session import SessionLocal
    from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
    from app.services.rag.gateway_factory import get_query_gateway
    from app.services.rag.runtime_resolver import RagRuntimeResolver
    from app.tasks.knowledge_tasks import index_document_task
    from shared.knowledge_contracts.retrieval_scope import RetrievalScope

    _check(
        settings.get_rag_runtime_mode("index") == "remote",
        "the stale-generation check requires the remote index mode",
    )

    with SessionLocal() as db:
        current = db.get(KnowledgeDocument, document_id)
        _check(current is not None, "the indexed document disappeared")
        attachment_id = int(current.attachment_id)

    with _local_data_plane_raises():
        # The task must stand down on the generation guard before it fetches the
        # attachment or reaches any indexing gateway.
        stale = index_document_task.apply(
            kwargs={
                "knowledge_base_id": str(knowledge_base_id),
                "attachment_id": attachment_id,
                "retriever_name": resource_name,
                "retriever_namespace": "default",
                "embedding_model_name": resource_name,
                "embedding_model_namespace": "default",
                "user_id": owner_user_id,
                "user_name": ADMIN_USER_NAME,
                "document_id": document_id,
                "index_generation": stale_generation,
                "trigger_summary": False,
            }
        ).get()

        _check(
            stale.get("status") == "skipped"
            and stale.get("reason") == "stale_generation",
            f"the stale generation must stand down: {stale}",
        )

        with SessionLocal() as db:
            document = db.get(KnowledgeDocument, document_id)
            _check(document is not None, "the indexed document disappeared")
            _check(
                document.index_status == DocumentIndexStatus.SUCCESS,
                f"the newest index must survive the stale task: {document.index_status}",
            )
            spec = RagRuntimeResolver().build_query_runtime_spec(
                db=db,
                knowledge_base_ids=[knowledge_base_id],
                query=marker,
                max_results=5,
                route_mode="rag_retrieval",
                scope=RetrievalScope(document_ids=[document_id]),
                user_id=owner_user_id,
                user_name=ADMIN_USER_NAME,
            )
            result = asyncio.run(get_query_gateway().query(spec, db=db))

    records = result.get("records", [])
    _check(
        any(record.get("document_id") == document_id for record in records),
        f"the runtime query must return the document reference: {records}",
    )


def _run_failure_scenario(client: httpx.Client, token: str, owner_user_id: int) -> None:
    """A runtime failure stays visible and is never hidden by a local success."""

    resource_name = f"e2e-failing-{uuid.uuid4().hex[:10]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=UNREACHABLE_EMBEDDING_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-FAIL-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_attachment(client, token, "WEGENT-E2E-FAILURE")
    document = _create_document(client, token, knowledge_base_id, attachment_id)
    document_id = int(document["id"])
    try:
        failed = _wait_for_index_status(
            client, token, knowledge_base_id, document_id, "failed"
        )
        error = failed.get("processing_error") or {}
        _check(
            error.get("code"),
            f"an index failure must be visible with a processing error: {failed}",
        )
        _log(
            "remote index failure surfaced: "
            f"status={failed['index_status']} code={error.get('code')} "
            f"message={error.get('message')}"
        )

        query = _internal_retrieve(
            client,
            knowledge_base_id,
            document_id,
            "WEGENT-E2E-FAILURE-QUERY",
            user_id=owner_user_id,
        )
        _check(
            query.status_code >= 500,
            "a query against the broken runtime resources must surface the remote "
            f"failure instead of succeeding locally: {query.status_code} {query.text}",
        )
        _log("remote query failure surfaced: " f"status={query.status_code}")
    finally:
        _delete_document(client, token, document_id)
        _delete_knowledge_base(client, token, knowledge_base_id)
        _delete_retrieval_resources(client, token, resource_name)


def _run_plain_document_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Create, index, query, rebuild, and re-index one plain document."""

    resource_name = f"e2e-remote-index-{uuid.uuid4().hex[:10]}"
    knowledge_base_name = f"E2E-KB-{resource_name}"
    marker_a = f"WEGENT-E2E-REMOTE-INDEX-A-{uuid.uuid4().hex[:8]}"
    marker_b = f"WEGENT-E2E-REMOTE-INDEX-B-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, knowledge_base_name, resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_attachment(client, token, marker_a)
    document = _create_document(client, token, knowledge_base_id, attachment_id)
    document_id = int(document["id"])
    _log(
        f"document {document_id} created in knowledge base {knowledge_base_id} "
        f"(index_status={document.get('index_status')})"
    )
    try:
        indexed = _wait_for_index_status(
            client, token, knowledge_base_id, document_id, "success"
        )
        _log(f"indexed through the runtime: generation={indexed['index_generation']}")
        chunks = _document_chunks(client, token, document_id)
        indexed_content = _chunk_contents(chunks)
        _check(
            marker_a in indexed_content,
            f"the indexed chunks must carry the uploaded content: {chunks}",
        )

        # The deterministic E2E embedding only carries the infrastructure contract,
        # so query with the exact indexed text: the mock returns a positive-similarity
        # vector for it and the document-scoped match stays deterministic.
        runtime = _runtime_query(
            knowledge_base_id,
            document_id,
            resource_name,
            owner_user_id,
            indexed_content,
        )
        _check(
            runtime.status_code == 200,
            f"the runtime query failed: {runtime.status_code} {runtime.text}",
        )
        runtime_records = runtime.json().get("records", [])
        _log(f"runtime query returned {len(runtime_records)} record(s)")
        _assert_records_reference_document(
            runtime_records, knowledge_base_id, document_id, marker_a
        )
        _log("the runtime store holds the document scope for this knowledge base")

        first_query = _internal_retrieve(
            client,
            knowledge_base_id,
            document_id,
            indexed_content,
            user_id=owner_user_id,
        )
        _check(
            first_query.status_code == 200,
            f"the scoped product query failed: {first_query.status_code} "
            f"{first_query.text}",
        )
        _assert_records_reference_document(
            first_query.json().get("records", []),
            knowledge_base_id,
            document_id,
            marker_a,
        )
        _log("the document-scoped product query returned the knowledge base reference")

        updated = client.put(
            f"/api/knowledge-documents/{document_id}/content",
            headers=_auth_headers(token),
            json={"content": f"# E2E plain document\n\n唯一断言标记：{marker_b}\n"},
        )
        _check(
            updated.status_code < 300,
            f"updating the document content failed: {updated.text}",
        )
        rebuilt = _wait_for_index_status(
            client,
            token,
            knowledge_base_id,
            document_id,
            "success",
            generation=int(indexed["index_generation"]) + 1,
        )
        rebuilt_chunks = _document_chunks(client, token, document_id)
        rebuilt_contents = _chunk_contents(rebuilt_chunks)
        _check(
            marker_b in rebuilt_contents and marker_a not in rebuilt_contents,
            "the rebuilt generation must replace the previous content: "
            f"{rebuilt_chunks}",
        )
        rebuilt_query = _internal_retrieve(
            client,
            knowledge_base_id,
            document_id,
            rebuilt_contents,
            user_id=owner_user_id,
        )
        _check(
            rebuilt_query.status_code == 200,
            f"the rebuilt scoped query failed: {rebuilt_query.text}",
        )
        _assert_records_reference_document(
            rebuilt_query.json().get("records", []),
            knowledge_base_id,
            document_id,
            marker_b,
        )
        _log(
            f"rebuild entry advanced the generation: "
            f"{indexed['index_generation']} -> {rebuilt['index_generation']}"
        )

        reindexed = client.post(
            f"/api/knowledge-documents/{document_id}/reindex",
            headers=_auth_headers(token),
        )
        _check(
            reindexed.status_code < 300,
            f"the rebuild entry was rejected: {reindexed.text}",
        )
        reindex_row = _wait_for_index_status(
            client,
            token,
            knowledge_base_id,
            document_id,
            "success",
            generation=int(rebuilt["index_generation"]) + 1,
        )
        final_chunks = _chunk_contents(_document_chunks(client, token, document_id))
        _check(
            marker_b in final_chunks and marker_a not in final_chunks,
            f"the explicit rebuild must keep the newest content: {final_chunks}",
        )
        _log(
            "explicit rebuild entry advanced the generation to "
            f"{reindex_row['index_generation']}"
        )

        _assert_remote_data_plane()
        _run_stale_generation_guard(
            knowledge_base_id,
            document_id,
            resource_name,
            owner_user_id,
            marker=rebuilt_contents,
            stale_generation=int(reindex_row["index_generation"]) - 1,
        )
        _log(
            "a stale indexing generation stood down and the newest result stayed "
            "served by the runtime"
        )
    finally:
        _delete_document(client, token, document_id)
        _delete_knowledge_base(client, token, knowledge_base_id)
        _delete_retrieval_resources(client, token, resource_name)


def run() -> None:
    _check(
        BACKEND_URL != KNOWLEDGE_RUNTIME_URL,
        "the Backend and the runtime must be separate services for this scenario",
    )
    _require_remote_services()
    with _create_client() as client:
        token, owner_user_id = _login(client)
        _run_plain_document_scenario(client, token, owner_user_id)
        _run_failure_scenario(client, token, owner_user_id)


if __name__ == "__main__":
    run()
    print("Knowledge remote index E2E passed")
