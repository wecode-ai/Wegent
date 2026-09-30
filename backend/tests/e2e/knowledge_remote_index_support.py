# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared fixtures and invariants for the knowledge remote index E2E.

The module talks to the real Backend over HTTP, builds real Retriever / Model /
KnowledgeBase / document fixtures, asserts the remote data plane serves a
document-scoped query, and asserts the deployment refuses local data-plane
calls for operations configured remote.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from typing import Any, Awaitable, Callable

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
MINERU_BASE_URL = os.environ.get(
    "E2E_MINERU_BASE_URL", f"{MOCK_MODEL_SERVER_URL}/mineru"
)
# Converted documents echo this marker back, so the scenario can prove that the
# converted body - not the uploaded source bytes - reached the remote index.
CONVERSION_MARKER_PREFIX = "WEGENT-E2E-CONVERT"
INTERNAL_SERVICE_TOKEN = os.environ.get("E2E_INTERNAL_SERVICE_TOKEN") or os.environ.get(
    "INTERNAL_SERVICE_TOKEN", ""
)
# The in-process remote calls use the Backend's own settings, so align the
# Backend variable with the E2E one when only the latter is provided.
if INTERNAL_SERVICE_TOKEN and not os.environ.get("INTERNAL_SERVICE_TOKEN"):
    os.environ["INTERNAL_SERVICE_TOKEN"] = INTERNAL_SERVICE_TOKEN
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
TASK_RESULT_TIMEOUT_SECONDS = float(os.environ.get("E2E_INDEX_TIMEOUT_SECONDS", "120"))
UNREACHABLE_EMBEDDING_URL = "http://127.0.0.1:1/v1/embeddings"
# A retriever pointed here keeps the Backend call real but makes the runtime's
# storage operation fail, which is how the delete-failure scenario is produced.
UNREACHABLE_QDRANT_URL = "http://127.0.0.1:1"


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
        json=_retriever_payload(name, QDRANT_URL),
    )
    _check(
        retriever.status_code < 300, f"creating the retriever failed: {retriever.text}"
    )


def _retriever_payload(name: str, storage_url: str) -> dict[str, Any]:
    """Build the Retriever CRD whose storage the runtime executes against."""

    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Retriever",
        "metadata": {"name": name, "namespace": "default"},
        "spec": {
            "storageConfig": {
                "type": "qdrant",
                "url": storage_url,
                "indexStrategy": {"mode": "per_dataset"},
            },
            "retrievalMethods": {"vector": {"enabled": True}},
        },
    }


def _point_retriever_at(client: httpx.Client, token: str, name: str, url: str) -> None:
    """Repoint one retriever's storage, so the next runtime call fails there."""

    response = client.put(
        f"/api/retrievers/{name}",
        headers=_auth_headers(token),
        json=_retriever_payload(name, url),
    )
    _check(
        response.status_code < 300,
        f"updating the retriever storage failed: {response.text}",
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
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    attachment_id: int,
    *,
    name: str = "release-notes.md",
    file_extension: str = "md",
) -> dict[str, Any]:
    response = client.post(
        f"/api/knowledge-bases/{knowledge_base_id}/documents",
        headers=_auth_headers(token),
        json={
            "attachment_id": attachment_id,
            "name": name,
            "file_extension": file_extension,
            "folder_id": 0,
            "source_type": "file",
        },
    )
    _check(response.status_code < 300, f"creating the document failed: {response.text}")
    return response.json()


def _upload_conversion_attachment(
    client: httpx.Client,
    token: str,
    marker: str,
    *,
    filename: str = "converted-source.pdf",
) -> tuple[int, bytes]:
    """Upload a source file whose bytes carry the marker MinerU echoes back."""

    content = _build_marker_pdf(marker)
    response = client.post(
        "/api/attachments/upload",
        headers=_auth_headers(token),
        files={"file": (filename, content, "application/pdf")},
    )
    _check(
        response.status_code == 200,
        f"uploading the conversion source failed: {response.text}",
    )
    return int(response.json()["id"]), content


def _build_marker_pdf(marker: str) -> bytes:
    """Build a minimal, structurally valid PDF carrying the marker text.

    The attachment parser validates the source PDF, so the fixture needs real
    xref offsets; the marker is embedded as page text and is what the simulated
    MinerU service echoes back into the converted Markdown.
    """

    content_stream = b"BT /F1 12 Tf 72 720 Td (" + marker.encode("ascii") + b") Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length "
        + str(len(content_stream)).encode("ascii")
        + b" >>\nstream\n"
        + content_stream
        + b"\nendstream",
    ]

    pdf = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

    xref_offset = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    pdf += b"0000000000 65535 f \n"
    for offset in offsets:
        pdf += f"{offset:010d} 00000 n \n".encode("ascii")
    pdf += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode("ascii")
    return bytes(pdf)


def _load_document_row(document_id: int) -> dict[str, Any]:
    """Read the raw document row fields the product API does not expose."""

    from app.db.session import SessionLocal
    from app.models.knowledge import KnowledgeDocument

    with SessionLocal() as db:
        document = db.get(KnowledgeDocument, document_id)
        _check(document is not None, f"document {document_id} disappeared")
        return {
            "id": int(document.id),
            "attachment_id": int(document.attachment_id),
            "converted_attachment_id": (
                int(document.converted_attachment_id)
                if document.converted_attachment_id is not None
                else None
            ),
            "index_generation": int(document.index_generation),
            "index_status": (
                document.index_status.value
                if hasattr(document.index_status, "value")
                else document.index_status
            ),
        }


def _post_conversion_completed(
    client: httpx.Client,
    *,
    document_id: int,
    generation: int,
    attachment_id: int,
    knowledge_base_id: int,
    markdown: bytes = b"# duplicate callback\n",
    converted_name: str = "duplicate.pdf.md",
) -> httpx.Response:
    """Re-post one conversion completion callback on the internal endpoint."""

    _check(INTERNAL_SERVICE_TOKEN, "the internal service token is required")
    return client.post(
        "/api/internal/conversion/callback/completed",
        headers={"Authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}"},
        json={
            "document_id": document_id,
            "generation": generation,
            "converted_name": converted_name,
            "converted_extension": "md",
            "file_size": len(markdown),
            "markdown_bytes": base64.b64encode(markdown).decode(),
            "index_dispatch_payload": {
                "attachment_id": attachment_id,
                "knowledge_base_id": knowledge_base_id,
                "document_id": document_id,
            },
        },
    )


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


def _await_task_decision(async_result: Any) -> dict[str, Any]:
    """Wait for the embedded Celery worker to finish one task and read its result."""

    deadline = time.monotonic() + TASK_RESULT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if async_result.ready():
            break
        time.sleep(0.5)
    _check(
        async_result.ready(),
        f"the queued indexing task {async_result.id} never finished",
    )
    decision = async_result.get(timeout=10)
    _check(
        isinstance(decision, dict),
        f"the queued indexing task returned an unexpected result: {decision!r}",
    )
    return decision


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


def _internal_retrieve_knowledge_base(
    client: httpx.Client,
    knowledge_base_id: int,
    query: str,
    *,
    user_id: int,
    max_results: int = 10,
) -> httpx.Response:
    """Query the authorized whole knowledge base, without a document scope."""

    _check(INTERNAL_SERVICE_TOKEN, "the internal service token is required")
    return client.post(
        "/api/internal/rag/retrieve",
        headers={"Authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}"},
        json={
            "query": query,
            "user_id": user_id,
            "knowledge_base_ids": [knowledge_base_id],
            "route_mode": "rag_retrieval",
            "max_results": max_results,
        },
    )


def _record_document_ids(records: list[dict[str, Any]]) -> list[int]:
    return sorted(
        {int(record["document_id"]) for record in records if record.get("document_id")}
    )


def _assert_no_record_for_document(
    records: list[dict[str, Any]], document_id: int
) -> None:
    offenders = [
        record for record in records if record.get("document_id") == document_id
    ]
    _check(
        not offenders,
        f"document {document_id} must not be hit any more: "
        f"{json.dumps(offenders, ensure_ascii=False)}",
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


def _delete_document_response(
    client: httpx.Client, token: str, document_id: int
) -> httpx.Response:
    return client.delete(
        f"/api/knowledge-documents/{document_id}", headers=_auth_headers(token)
    )


def _delete_document(client: httpx.Client, token: str, document_id: int) -> None:
    response = _delete_document_response(client, token, document_id)
    _check(response.status_code < 300, f"deleting the document failed: {response.text}")


def _document_row_exists(document_id: int) -> bool:
    """Read the raw row so a failed delete can be told apart from a partial one."""

    from app.db.session import SessionLocal
    from app.models.knowledge import KnowledgeDocument

    with SessionLocal() as db:
        return db.get(KnowledgeDocument, document_id) is not None


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


def _assert_remote_gateways() -> None:
    """Index, delete, and query must resolve to the remote runtime."""

    from app.core.config import settings
    from app.services.rag.gateway_factory import (
        get_delete_gateway,
        get_index_gateway,
        get_query_gateway,
    )
    from app.services.rag.remote_gateway import RemoteRagGateway

    for operation in ("index", "delete", "query"):
        _check(
            settings.get_rag_runtime_mode(operation) == "remote",
            f"the Backend must run '{operation}' through the remote runtime",
        )
    for operation, gateway in (
        ("index", get_index_gateway()),
        ("delete", get_delete_gateway()),
        ("query", get_query_gateway()),
    ):
        _check(
            isinstance(gateway, RemoteRagGateway),
            f"the {operation} gateway must be the remote gateway",
        )


def _expect_local_operation_refused(
    operation: str,
    call: Callable[[], Awaitable[Any]],
) -> None:
    """The local gateway itself must refuse an operation configured remote."""

    from app.services.rag.local_gateway import LocalDataPlaneDisabledError

    try:
        asyncio.run(call())
    except LocalDataPlaneDisabledError as error:
        _check(
            error.operation == operation,
            f"the local refusal named {error.operation}, expected {operation}",
        )
        return
    raise KnowledgeRemoteIndexE2EError(
        f"local {operation} must fail while '{operation}' is configured remote"
    )


def _assert_local_operations_are_refused(
    knowledge_base_id: int,
    document_id: int,
    resource_name: str,
    owner_user_id: int,
) -> None:
    """Local indexing, index deletion, and retrieval must fail immediately.

    The guard lives in ``LocalRagGateway``, so the Backend process and the
    embedded Celery worker refuse a local fallback exactly like this process.
    """

    from app.db.session import SessionLocal
    from app.models.knowledge import KnowledgeDocument
    from app.services.rag.local_gateway import LocalRagGateway
    from app.services.rag.runtime_specs import (
        DeleteRuntimeSpec,
        IndexRuntimeSpec,
        IndexSource,
        QueryRuntimeSpec,
    )
    from shared.knowledge_contracts.runtime_config import RuntimeRetrieverConfig

    with SessionLocal() as db:
        document = db.get(KnowledgeDocument, document_id)
        _check(document is not None, "the indexed document disappeared")
        attachment_id = int(document.attachment_id)

    local = LocalRagGateway()
    index_spec = IndexRuntimeSpec(
        knowledge_base_id=knowledge_base_id,
        document_id=document_id,
        index_owner_user_id=owner_user_id,
        retriever_name=resource_name,
        retriever_namespace="default",
        embedding_model_name=resource_name,
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=attachment_id),
    )
    delete_spec = DeleteRuntimeSpec(
        knowledge_base_id=knowledge_base_id,
        document_ref=str(document_id),
        index_owner_user_id=owner_user_id,
        retriever_config=RuntimeRetrieverConfig(
            name=resource_name,
            namespace="default",
            storage_config={"type": "qdrant", "url": QDRANT_URL},
        ),
    )
    query_spec = QueryRuntimeSpec(
        knowledge_base_ids=[knowledge_base_id],
        query="WEGENT-E2E-LOCAL-GUARD",
        route_mode="rag_retrieval",
    )

    _expect_local_operation_refused(
        "index", lambda: local.index_document(index_spec, db=None)
    )
    _expect_local_operation_refused(
        "delete", lambda: local.delete_document_index(delete_spec, db=None)
    )
    with SessionLocal() as db:
        _expect_local_operation_refused("query", lambda: local.query(query_spec, db=db))
    _log("local index, delete, and retrieval calls are refused by the gateway")


def _delete_scenario_fixtures(
    client: httpx.Client,
    token: str,
    *,
    document_id: int,
    knowledge_base_id: int,
    resource_name: str,
) -> None:
    _delete_document(client, token, document_id)
    _delete_knowledge_base(client, token, knowledge_base_id)
    _delete_retrieval_resources(client, token, resource_name)
