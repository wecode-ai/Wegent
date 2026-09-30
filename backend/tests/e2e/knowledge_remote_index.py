# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CI E2E coverage for document indexing through the remote runtime.

The scenarios drive the product entries end to end: the document
create/rebuild entries enqueue an indexing generation, the real Celery task
fetches the attachment content, ``knowledge_runtime`` resolves the index
configuration through the shared module and writes Qdrant, and a
document-scoped product query returns the knowledge base and document
references.

A converted document follows the same chain: the product entry queues the
MinerU conversion task, the real ``knowledge_doc_converter`` worker converts the
source, the conversion callback swaps in the converted Markdown, and the index
carries the converted body. Only MinerU itself is simulated.

MySQL, Redis, object storage, the runtime process, Qdrant, the converter worker
and the backend callbacks are real. Only the external embedding and
document-parsing HTTP endpoints are deterministic mocks. The remote data plane
is the only data plane: the local gateway must resolve to remote for indexing
and querying, the in-process scoped query fails if any local data plane method
runs, and a superseded generation dispatched through the broker must stand down
instead of overwriting the newer result. Deleting a document removes exactly its
own references while its siblings stay searchable, a repeated delete or a late
index task does not revive them, and a runtime removal failure stays visible with
its own status and detail instead of being masked by a local success. A runtime
or conversion failure must stay visible with its own status and detail rather
than by a local success.

Run from ``backend/`` after the CI services are up:

    uv run --no-sync python tests/e2e/knowledge_remote_index.py
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

import httpx
from knowledge_remote_index_support import (
    ADMIN_USER_NAME,
    BACKEND_URL,
    CONVERSION_MARKER_PREFIX,
    EMBEDDING_MODEL_URL,
    INDEX_TIMEOUT_SECONDS,
    KNOWLEDGE_RUNTIME_URL,
    QDRANT_URL,
    TASK_RESULT_TIMEOUT_SECONDS,
    UNREACHABLE_EMBEDDING_URL,
    UNREACHABLE_QDRANT_URL,
    KnowledgeRemoteIndexE2EError,
    _assert_local_operations_are_refused,
    _assert_no_record_for_document,
    _assert_records_reference_document,
    _assert_remote_gateways,
    _auth_headers,
    _check,
    _chunk_contents,
    _create_client,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_document,
    _delete_document_response,
    _delete_knowledge_base,
    _delete_retrieval_resources,
    _delete_scenario_fixtures,
    _document_chunks,
    _document_row_exists,
    _internal_retrieve,
    _internal_retrieve_knowledge_base,
    _load_document_row,
    _log,
    _login,
    _point_retriever_at,
    _post_conversion_completed,
    _record_document_ids,
    _require_remote_services,
    _runtime_query,
    _upload_attachment,
    _upload_conversion_attachment,
    _wait_for_index_status,
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


def _assert_stale_generation_stands_down(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    document_id: int,
    resource_name: str,
    owner_user_id: int,
    *,
    expected_generation: int,
    marker: str,
) -> None:
    """A stale generation queued after the newest index must not overwrite it."""

    from app.db.session import SessionLocal
    from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
    from app.tasks.knowledge_tasks import index_document_task

    with SessionLocal() as db:
        document = db.get(KnowledgeDocument, document_id)
        _check(document is not None, "the indexed document disappeared")
        attachment_id = int(document.attachment_id)
        _check(
            int(document.index_generation) == expected_generation,
            f"the document is in generation {document.index_generation}, "
            f"expected {expected_generation}",
        )

    # Queue the superseded generation through the real broker so the embedded
    # worker - not the test process - decides whether it may write.
    stale_task = index_document_task.delay(
        knowledge_base_id=str(knowledge_base_id),
        attachment_id=attachment_id,
        retriever_name=resource_name,
        retriever_namespace="default",
        embedding_model_name=resource_name,
        embedding_model_namespace="default",
        user_id=owner_user_id,
        user_name=ADMIN_USER_NAME,
        document_id=document_id,
        index_generation=expected_generation - 1,
        trigger_summary=False,
    )
    decision = _await_task_decision(stale_task)
    _check(
        decision.get("status") == "skipped"
        and decision.get("reason") == "stale_generation",
        f"the stale generation must stand down: {decision}",
    )

    row = _wait_for_index_status(
        client,
        token,
        knowledge_base_id,
        document_id,
        "success",
        generation=expected_generation,
    )
    _check(
        row.get("index_status") == DocumentIndexStatus.SUCCESS.value,
        f"the newest index must survive the stale task: {row}",
    )
    contents = _chunk_contents(_document_chunks(client, token, document_id))
    _check(
        marker in contents,
        f"the stale task must not overwrite the newest content: {contents}",
    )
    _log(
        "a superseded generation queued through the broker stood down and the "
        "newest result stayed indexed"
    )


def _assert_in_process_scoped_query(
    knowledge_base_id: int,
    document_id: int,
    owner_user_id: int,
    query: str,
) -> None:
    """A non-HTTP caller resolves and executes the scoped query remotely."""

    from app.db.session import SessionLocal
    from app.services.rag.gateway_factory import get_query_gateway
    from app.services.rag.runtime_resolver import RagRuntimeResolver
    from shared.knowledge_contracts.retrieval_scope import RetrievalScope

    with SessionLocal() as db:
        spec = RagRuntimeResolver().build_query_runtime_spec(
            db=db,
            knowledge_base_ids=[knowledge_base_id],
            query=query,
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


def _assert_duplicate_and_stale_conversion_callbacks_are_skipped(
    client: httpx.Client,
    token: str,
    *,
    knowledge_base_id: int,
    document_id: int,
    generation: int,
    marker: str,
) -> None:
    """A repeated or superseded completion callback must change nothing."""

    row = _load_document_row(document_id)
    original_attachment_id = row["attachment_id"]
    converted_attachment_id = row["converted_attachment_id"]
    _check(
        converted_attachment_id is not None,
        "the converted document must reference a converted attachment",
    )
    _check(
        converted_attachment_id != original_attachment_id,
        "the converted attachment must be a new attachment, not the source",
    )

    duplicate = _post_conversion_completed(
        client,
        document_id=document_id,
        generation=generation,
        attachment_id=original_attachment_id,
        knowledge_base_id=knowledge_base_id,
        markdown=b"# duplicate callback must not be indexed\n",
    )
    _check(
        duplicate.status_code < 300,
        f"the duplicate completion callback failed: {duplicate.text}",
    )
    _check(
        duplicate.json().get("skipped") is True,
        f"a duplicate completion callback must be skipped: {duplicate.text}",
    )

    superseded = _post_conversion_completed(
        client,
        document_id=document_id,
        generation=generation - 1,
        attachment_id=original_attachment_id,
        knowledge_base_id=knowledge_base_id,
        markdown=b"# superseded callback must not be indexed\n",
    )
    _check(
        superseded.status_code < 300,
        f"the superseded completion callback failed: {superseded.text}",
    )
    _check(
        superseded.json().get("skipped") is True,
        f"a superseded completion callback must be skipped: {superseded.text}",
    )

    after = _load_document_row(document_id)
    _check(
        after["converted_attachment_id"] == converted_attachment_id,
        "a repeated callback must not replace the converted attachment",
    )
    _check(
        after["index_status"] == "success",
        f"the indexed document must keep its status: {after}",
    )
    contents = _chunk_contents(_document_chunks(client, token, document_id))
    _check(
        marker in contents and "duplicate callback" not in contents,
        "a repeated callback must not overwrite the indexed converted body",
    )
    _log("duplicate and superseded conversion callbacks were skipped")


def _run_converted_document_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Upload a PDF, convert it, index the converted body, and query it back."""

    resource_name = f"e2e-converted-{uuid.uuid4().hex[:10]}"
    marker = f"{CONVERSION_MARKER_PREFIX}-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-CONV-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_conversion_attachment(client, token, marker)
    document = _create_document(
        client,
        token,
        knowledge_base_id,
        attachment_id,
        name="converted-source.pdf",
        file_extension="pdf",
    )
    document_id = int(document["id"])
    _log(
        f"conversion document {document_id} created in knowledge base "
        f"{knowledge_base_id} (index_status={document.get('index_status')})"
    )
    try:
        indexed = _wait_for_index_status(
            client, token, knowledge_base_id, document_id, "success"
        )
        generation = int(indexed["index_generation"])
        contents = _chunk_contents(_document_chunks(client, token, document_id))
        _check(
            marker in contents,
            f"the converted body must reach the index: {contents}",
        )
        _check(
            "# 转换后的文档" in contents,
            "the indexed body must be the converted markdown, not the source "
            f"bytes: {contents}",
        )

        runtime = _runtime_query(
            knowledge_base_id, document_id, resource_name, owner_user_id, contents
        )
        _check(
            runtime.status_code == 200,
            f"the runtime query failed: {runtime.status_code} {runtime.text}",
        )
        _assert_records_reference_document(
            runtime.json().get("records", []), knowledge_base_id, document_id, marker
        )

        query = _internal_retrieve(
            client, knowledge_base_id, document_id, contents, user_id=owner_user_id
        )
        _check(
            query.status_code == 200,
            f"the document-scoped query failed: {query.status_code} {query.text}",
        )
        _assert_records_reference_document(
            query.json().get("records", []), knowledge_base_id, document_id, marker
        )
        _log(
            "the converted document indexed through the runtime and a "
            "document-scoped query returned its reference"
        )

        _assert_duplicate_and_stale_conversion_callbacks_are_skipped(
            client,
            token,
            knowledge_base_id=knowledge_base_id,
            document_id=document_id,
            generation=generation,
            marker=marker,
        )
        _assert_stale_generation_stands_down(
            client,
            token,
            knowledge_base_id,
            document_id,
            resource_name,
            owner_user_id,
            expected_generation=generation,
            marker=marker,
        )
        _assert_local_operations_are_refused(
            knowledge_base_id, document_id, resource_name, owner_user_id
        )
        _assert_in_process_scoped_query(
            knowledge_base_id, document_id, owner_user_id, contents
        )
        _log(f"converted document {document_id} finished in generation {generation}")
    finally:
        _delete_scenario_fixtures(
            client,
            token,
            document_id=document_id,
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
        )


def _run_conversion_failure_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """A failed conversion stays visible and leaves nothing queryable."""

    resource_name = f"e2e-convert-fail-{uuid.uuid4().hex[:10]}"
    marker = f"{CONVERSION_MARKER_PREFIX}-FAIL-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-CONV-FAIL-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_conversion_attachment(client, token, marker)
    document = _create_document(
        client,
        token,
        knowledge_base_id,
        attachment_id,
        name="converted-source.pdf",
        file_extension="pdf",
    )
    document_id = int(document["id"])
    try:
        failed = _wait_for_index_status(
            client, token, knowledge_base_id, document_id, "failed"
        )
        error = failed.get("processing_error") or {}
        _check(
            error.get("code"),
            f"a conversion failure must be visible with a processing error: {failed}",
        )
        _log(
            "conversion failure surfaced: "
            f"status={failed['index_status']} code={error.get('code')} "
            f"message={error.get('message')}"
        )

        row = _load_document_row(document_id)
        _check(
            row["converted_attachment_id"] is None,
            "a failed conversion must not leave a converted body on the document: "
            f"{row}",
        )

        # The document was never indexed, so a scoped query must not return it.
        # An empty knowledge base has no backing collection yet; that surfaces as
        # a visible failure with a detail rather than as a stale hit.
        query = _internal_retrieve(
            client, knowledge_base_id, document_id, marker, user_id=owner_user_id
        )
        if query.status_code == 200:
            records = query.json().get("records", [])
        else:
            detail = (
                query.json().get("detail")
                if "json" in query.headers.get("content-type", "")
                else ""
            )
            _check(
                query.status_code >= 500 and isinstance(detail, str) and detail,
                "an unindexed document must fail visibly instead of returning a "
                f"stale result: {query.status_code} {query.text}",
            )
            records = []
        _check(
            records == [],
            f"a failed conversion must leave nothing queryable: {records}",
        )
        _log("the failed conversion left no queryable result")
    finally:
        _delete_scenario_fixtures(
            client,
            token,
            document_id=document_id,
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
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
        runtime = _runtime_query(
            knowledge_base_id,
            document_id,
            resource_name,
            owner_user_id,
            "WEGENT-E2E-FAILURE-QUERY",
        )
        _check(
            runtime.status_code >= 500,
            "the runtime itself must fail for the broken resources: "
            f"{runtime.status_code} {runtime.text}",
        )
        _check(
            query.status_code >= 500,
            "a query against the broken runtime resources must surface the remote "
            f"failure instead of succeeding locally: {query.status_code} {query.text}",
        )
        detail = (
            query.json().get("detail")
            if "json" in query.headers.get("content-type", "")
            else ""
        )
        _check(
            isinstance(detail, str) and detail,
            f"the surfaced remote failure must carry a detail: {query.text}",
        )
        _log(
            "remote query failure surfaced: "
            f"runtime_status={runtime.status_code} backend_status={query.status_code} "
            f"detail={detail}"
        )
    finally:
        _delete_scenario_fixtures(
            client,
            token,
            document_id=document_id,
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
        )


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
        indexed_content, generation = _index_and_query_document(
            client,
            token,
            knowledge_base_id,
            document_id,
            resource_name,
            owner_user_id,
            marker_a,
        )
        rebuilt_content, generation = _rebuild_with_new_content(
            client,
            token,
            knowledge_base_id,
            document_id,
            owner_user_id,
            previous_generation=generation,
            marker_a=marker_a,
            marker_b=marker_b,
        )
        generation = _rebuild_through_entry(
            client,
            token,
            knowledge_base_id,
            document_id,
            previous_generation=generation,
            marker_b=marker_b,
        )
        _assert_stale_generation_stands_down(
            client,
            token,
            knowledge_base_id,
            document_id,
            resource_name,
            owner_user_id,
            expected_generation=generation,
            marker=marker_b,
        )
        _assert_remote_gateways()
        _assert_local_operations_are_refused(
            knowledge_base_id, document_id, resource_name, owner_user_id
        )
        _assert_in_process_scoped_query(
            knowledge_base_id, document_id, owner_user_id, rebuilt_content
        )
        _check(
            marker_a not in rebuilt_content,
            "the newest generation must not contain the superseded content",
        )
        _log(f"plain document {document_id} finished in generation {generation}")
    finally:
        _delete_scenario_fixtures(
            client,
            token,
            document_id=document_id,
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
        )


def _index_and_query_document(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    document_id: int,
    resource_name: str,
    owner_user_id: int,
    marker: str,
) -> tuple[str, int]:
    """Create-path indexing, runtime store evidence, and one scoped query."""

    indexed = _wait_for_index_status(
        client, token, knowledge_base_id, document_id, "success"
    )
    generation = int(indexed["index_generation"])
    _log(f"indexed through the runtime: generation={generation}")
    chunks = _document_chunks(client, token, document_id)
    indexed_content = _chunk_contents(chunks)
    _check(
        marker in indexed_content,
        f"the indexed chunks must carry the uploaded content: {chunks}",
    )

    # The deterministic E2E embedding only carries the infrastructure contract
    # and the index embeds metadata-prefixed text, so query with the exact indexed
    # text: the mock scores it above a zero threshold and the document-scoped match
    # stays deterministic instead of relying on a random similarity draw.
    runtime = _runtime_query(
        knowledge_base_id, document_id, resource_name, owner_user_id, indexed_content
    )
    _check(
        runtime.status_code == 200,
        f"the runtime query failed: {runtime.status_code} {runtime.text}",
    )
    _assert_records_reference_document(
        runtime.json().get("records", []), knowledge_base_id, document_id, marker
    )
    _log("the runtime store holds the document scope for this knowledge base")

    query = _internal_retrieve(
        client, knowledge_base_id, document_id, indexed_content, user_id=owner_user_id
    )
    _check(
        query.status_code == 200,
        f"the scoped product query failed: {query.status_code} {query.text}",
    )
    _assert_records_reference_document(
        query.json().get("records", []), knowledge_base_id, document_id, marker
    )
    _log("the document-scoped product query returned the knowledge base reference")
    return indexed_content, generation


def _rebuild_with_new_content(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    document_id: int,
    owner_user_id: int,
    *,
    previous_generation: int,
    marker_a: str,
    marker_b: str,
) -> tuple[str, int]:
    """The content-update entry must index the new generation and drop the old."""

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
        generation=previous_generation + 1,
    )
    generation = int(rebuilt["index_generation"])
    chunks = _document_chunks(client, token, document_id)
    content = _chunk_contents(chunks)
    _check(
        marker_b in content and marker_a not in content,
        f"the rebuilt generation must replace the previous content: {chunks}",
    )
    query = _internal_retrieve(
        client, knowledge_base_id, document_id, content, user_id=owner_user_id
    )
    _check(
        query.status_code == 200,
        f"the rebuilt scoped query failed: {query.text}",
    )
    _assert_records_reference_document(
        query.json().get("records", []), knowledge_base_id, document_id, marker_b
    )
    _log(
        f"content update advanced the generation: "
        f"{previous_generation} -> {generation}"
    )
    return content, generation


def _rebuild_through_entry(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    document_id: int,
    *,
    previous_generation: int,
    marker_b: str,
) -> int:
    """The explicit rebuild entry must re-index the newest stored content."""

    reindexed = client.post(
        f"/api/knowledge-documents/{document_id}/reindex", headers=_auth_headers(token)
    )
    _check(
        reindexed.status_code < 300,
        f"the rebuild entry was rejected: {reindexed.text}",
    )
    row = _wait_for_index_status(
        client,
        token,
        knowledge_base_id,
        document_id,
        "success",
        generation=previous_generation + 1,
    )
    contents = _chunk_contents(_document_chunks(client, token, document_id))
    _check(
        marker_b in contents,
        f"the explicit rebuild must keep the newest content: {contents}",
    )
    _log(f"explicit rebuild entry advanced the generation to {row['index_generation']}")
    return int(row["index_generation"])


def _assert_late_index_task_stands_down(
    *,
    document_id: int,
    attachment_id: int,
    knowledge_base_id: int,
    resource_name: str,
    owner_user_id: int,
    generation: int,
) -> None:
    """An index task queued before the delete must not revive the reference."""

    from app.tasks.knowledge_tasks import index_document_task

    # Queue through the real broker so the embedded worker - not the test
    # process - decides whether a task for a deleted document may write.
    late_task = index_document_task.delay(
        knowledge_base_id=str(knowledge_base_id),
        attachment_id=attachment_id,
        retriever_name=resource_name,
        retriever_namespace="default",
        embedding_model_name=resource_name,
        embedding_model_namespace="default",
        user_id=owner_user_id,
        user_name=ADMIN_USER_NAME,
        document_id=document_id,
        index_generation=generation,
        trigger_summary=False,
    )
    decision = _await_task_decision(late_task)
    _check(
        decision.get("status") == "skipped"
        and decision.get("reason") == "document_not_found",
        f"a task for a deleted document must stand down: {decision}",
    )
    _log(
        f"a late index task for deleted document {document_id} stood down "
        "without restoring its reference"
    )


def _run_document_delete_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Deleting one document removes its references and keeps its siblings."""

    # The delete entry must resolve to the remote gateway for this scenario:
    # every local data-plane delete call is refused under the deployment mode.
    _assert_remote_gateways()
    resource_name = f"e2e-delete-{uuid.uuid4().hex[:10]}"
    marker_a = f"WEGENT-E2E-DELETE-A-{uuid.uuid4().hex[:8]}"
    marker_b = f"WEGENT-E2E-DELETE-B-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-DELETE-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_a, _ = _upload_attachment(client, token, marker_a)
    document_a = _create_document(client, token, knowledge_base_id, attachment_a)
    document_a_id = int(document_a["id"])
    attachment_b, _ = _upload_attachment(client, token, marker_b)
    document_b = _create_document(client, token, knowledge_base_id, attachment_b)
    document_b_id = int(document_b["id"])
    _log(
        f"delete scenario documents {document_a_id} and {document_b_id} created in "
        f"knowledge base {knowledge_base_id}"
    )
    try:
        indexed_a = _wait_for_index_status(
            client, token, knowledge_base_id, document_a_id, "success"
        )
        _wait_for_index_status(
            client, token, knowledge_base_id, document_b_id, "success"
        )
        document_a_row = _load_document_row(document_a_id)
        generation = int(indexed_a["index_generation"])

        before = _internal_retrieve_knowledge_base(
            client, knowledge_base_id, marker_a, user_id=owner_user_id
        )
        _check(
            before.status_code == 200,
            f"the knowledge-base query failed: {before.status_code} {before.text}",
        )
        before_records = before.json().get("records", [])
        _check(
            _record_document_ids(before_records)
            == sorted([document_a_id, document_b_id]),
            f"both documents must be hit before the delete: {before.text}",
        )

        _delete_document(client, token, document_a_id)
        _check(
            not _document_row_exists(document_a_id),
            f"the deleted document {document_a_id} must be gone",
        )
        _log(f"deleted document {document_a_id} through the product entry")

        after = _internal_retrieve_knowledge_base(
            client, knowledge_base_id, marker_a, user_id=owner_user_id
        )
        _check(
            after.status_code == 200,
            f"the post-delete query failed: {after.status_code} {after.text}",
        )
        after_records = after.json().get("records", [])
        _assert_no_record_for_document(after_records, document_a_id)
        _assert_records_reference_document(
            after_records, knowledge_base_id, document_b_id, marker_b
        )
        _log(
            "the deleted document is no longer hit and the other document stayed "
            f"searchable: {_record_document_ids(after_records)}"
        )

        # A duplicate delete of the same document must not resurrect anything.
        duplicate = _delete_document_response(client, token, document_a_id)
        _check(
            duplicate.status_code == 404,
            f"a repeated delete must report a missing document: {duplicate.text}",
        )
        after_duplicate = _internal_retrieve_knowledge_base(
            client, knowledge_base_id, marker_a, user_id=owner_user_id
        )
        _assert_no_record_for_document(
            after_duplicate.json().get("records", []), document_a_id
        )

        # An index task that was queued before the delete must not restore it.
        _assert_late_index_task_stands_down(
            document_id=document_a_id,
            attachment_id=document_a_row["attachment_id"],
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
            owner_user_id=owner_user_id,
            generation=generation,
        )
        final = _internal_retrieve_knowledge_base(
            client, knowledge_base_id, marker_a, user_id=owner_user_id
        )
        _assert_no_record_for_document(final.json().get("records", []), document_a_id)
        _log(
            f"document delete scenario finished for knowledge base {knowledge_base_id}"
        )
    finally:
        _delete_document(client, token, document_b_id)
        _delete_knowledge_base(client, token, knowledge_base_id)
        _delete_retrieval_resources(client, token, resource_name)


def _run_delete_failure_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """A remote removal failure stays visible and the retry can still succeed."""

    _assert_remote_gateways()
    resource_name = f"e2e-delete-fail-{uuid.uuid4().hex[:10]}"
    marker = f"WEGENT-E2E-DELETE-FAIL-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-DELETE-FAIL-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_attachment(client, token, marker)
    document = _create_document(client, token, knowledge_base_id, attachment_id)
    document_id = int(document["id"])
    try:
        _wait_for_index_status(client, token, knowledge_base_id, document_id, "success")

        # Point the retriever at a store that cannot be reached, so the runtime's
        # removal fails while the Backend request itself stays valid.
        _point_retriever_at(client, token, resource_name, UNREACHABLE_QDRANT_URL)
        failed = _delete_document_response(client, token, document_id)
        detail = (
            failed.json().get("detail")
            if "json" in failed.headers.get("content-type", "")
            else ""
        )
        _check(
            failed.status_code >= 500,
            "a remote removal failure must surface instead of a local success: "
            f"{failed.status_code} {failed.text}",
        )
        _check(
            isinstance(detail, str) and detail,
            f"the surfaced removal failure must carry a detail: {failed.text}",
        )
        _check(
            _document_row_exists(document_id),
            "the document must be kept when its remote index could not be removed",
        )
        _log(
            "remote delete failure surfaced: "
            f"status={failed.status_code} detail={detail}"
        )

        # Retrying after the store is reachable again removes the document.
        _point_retriever_at(client, token, resource_name, QDRANT_URL)
        _delete_document(client, token, document_id)
        _check(
            not _document_row_exists(document_id),
            f"the retried delete must remove document {document_id}",
        )
        _log(f"retried delete removed document {document_id} and stayed visible")
    finally:
        if _document_row_exists(document_id):
            _point_retriever_at(client, token, resource_name, QDRANT_URL)
            _delete_document_response(client, token, document_id)
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
        _run_converted_document_scenario(client, token, owner_user_id)
        _run_conversion_failure_scenario(client, token, owner_user_id)
        _run_document_delete_scenario(client, token, owner_user_id)
        _run_delete_failure_scenario(client, token, owner_user_id)
        _run_failure_scenario(client, token, owner_user_id)


if __name__ == "__main__":
    run()
    print("Knowledge remote index E2E passed")
