# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CI E2E scenarios for removing a document's remote index.

These run inside the shared ``knowledge_remote_index`` scenario: deleting one of
two documents must drop only its own references, a repeated delete or a late
index task must not revive them, and a runtime removal failure must stay visible
with a retry that can still succeed.
"""

from __future__ import annotations

import uuid

import httpx
from knowledge_remote_index_support import (
    ADMIN_USER_NAME,
    EMBEDDING_MODEL_URL,
    QDRANT_URL,
    UNREACHABLE_QDRANT_URL,
    _assert_no_record_for_document,
    _assert_records_reference_document,
    _assert_remote_gateways,
    _auth_headers,
    _await_task_decision,
    _check,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_document,
    _delete_document_response,
    _delete_knowledge_base,
    _delete_retrieval_resources,
    _document_row_exists,
    _internal_retrieve_knowledge_base,
    _load_document_row,
    _log,
    _point_retriever_at,
    _record_document_ids,
    _upload_attachment,
    _wait_for_index_status,
)


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


def run_document_delete_scenario(
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


def run_delete_failure_scenario(
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
