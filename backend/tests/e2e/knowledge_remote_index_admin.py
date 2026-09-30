# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CI E2E scenarios for managing a knowledge base's remote index.

These run inside the shared ``knowledge_remote_index`` scenario: listing the
indexed chunks, clearing every chunk of a knowledge base, and dropping its
physical index all execute in ``knowledge_runtime``. The chunk and query results
after each operation match the operation, a runtime failure stays visible with
its own status and detail instead of a local success, and the local data plane
refuses every one of these operations while the deployment is configured remote.
"""

from __future__ import annotations

import uuid
from typing import Callable

import httpx
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    QDRANT_URL,
    UNREACHABLE_QDRANT_URL,
    _assert_admin_remote_gateways,
    _assert_local_admin_operations_are_refused,
    _auth_headers,
    _check,
    _chunk_contents,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _create_retriever_only,
    _delete_document,
    _delete_knowledge_base,
    _delete_retrieval_resources,
    _internal_retrieve_knowledge_base,
    _log,
    _point_retriever_at,
    _public_drop_index,
    _public_list_chunks,
    _public_purge_index,
    _response_detail,
    _runtime_list_chunks,
    _upload_attachment,
    _wait_for_index_status,
)


def _listed_items(response: httpx.Response) -> list[dict]:
    _check(
        response.status_code == 200,
        f"listing the chunks failed: {response.status_code} {response.text}",
    )
    return list(response.json().get("items", []))


def _assert_marker_listed(items: list[dict], marker: str, context: str) -> None:
    contents = _chunk_contents(items)
    _check(
        marker in contents,
        f"{context} must list the indexed content {marker}: {contents}",
    )


def _assert_no_queryable_result(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    marker: str,
    owner_user_id: int,
    context: str,
) -> None:
    """The knowledge base query must not return a stale hit after the operation."""

    query = _internal_retrieve_knowledge_base(
        client, knowledge_base_id, marker, user_id=owner_user_id
    )
    if query.status_code == 200:
        records = query.json().get("records", [])
        _check(
            records == [],
            f"{context} must leave nothing queryable: {query.text}",
        )
        _log(f"{context}: the knowledge base query returned no record")
        return

    detail = _response_detail(query)
    _check(
        query.status_code >= 500 and detail,
        f"{context} must either return no record or fail visibly: "
        f"{query.status_code} {query.text}",
    )
    _log(
        f"{context}: the knowledge base query failed visibly with "
        f"{query.status_code} {detail}"
    )


def _run_list_and_purge_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Listing exposes the runtime's chunks, and purging removes exactly them."""

    _assert_admin_remote_gateways()
    resource_name = f"e2e-admin-{uuid.uuid4().hex[:10]}"
    marker = f"WEGENT-E2E-ADMIN-PURGE-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-ADMIN-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_attachment(client, token, marker)
    document = _create_document(client, token, knowledge_base_id, attachment_id)
    document_id = int(document["id"])
    _log(
        f"admin scenario document {document_id} created in knowledge base "
        f"{knowledge_base_id}"
    )
    try:
        indexed = _wait_for_index_status(
            client, token, knowledge_base_id, document_id, "success"
        )
        generation = int(indexed["index_generation"])
        _assert_local_admin_operations_are_refused(knowledge_base_id, owner_user_id)

        listed = _public_list_chunks(client, token, knowledge_base_id)
        items = _listed_items(listed)
        _check(
            int(listed.json().get("total", 0)) > 0,
            f"the indexed knowledge base must list chunks: {listed.text}",
        )
        _assert_marker_listed(
            items, marker, f"the public chunk listing for {knowledge_base_id}"
        )

        # The runtime store itself holds the same chunks, so the listing is not
        # served from a Backend-side copy.
        runtime_chunks = _runtime_list_chunks(knowledge_base_id, owner_user_id)
        _check(
            runtime_chunks.status_code == 200,
            f"the runtime chunk listing failed: {runtime_chunks.status_code} "
            f"{runtime_chunks.text}",
        )
        _assert_marker_listed(
            list(runtime_chunks.json().get("chunks", [])),
            marker,
            f"the runtime store for {knowledge_base_id}",
        )
        _log(
            f"the runtime store and the public entry listed the chunks of "
            f"knowledge base {knowledge_base_id}"
        )

        purged = _public_purge_index(client, token, knowledge_base_id)
        _check(
            purged.status_code == 200,
            f"the purge entry failed: {purged.status_code} {purged.text}",
        )
        body = purged.json()
        _check(
            body.get("status") == "deleted",
            f"the purge entry must report a deletion: {purged.text}",
        )
        _check(
            int(body.get("deleted_chunks", 0)) > 0,
            f"the purge entry must remove the indexed chunks: {purged.text}",
        )
        _log(f"purged knowledge base {knowledge_base_id}: {body}")

        after_runtime = _runtime_list_chunks(knowledge_base_id, owner_user_id)
        _check(
            after_runtime.status_code == 200
            and after_runtime.json().get("chunks") == [],
            f"the runtime store must be empty after the purge: "
            f"{after_runtime.status_code} {after_runtime.text}",
        )
        after_list = _public_list_chunks(client, token, knowledge_base_id)
        _check(
            after_list.status_code == 200
            and int(after_list.json().get("total", 0)) == 0,
            f"the public listing must be empty after the purge: "
            f"{after_list.status_code} {after_list.text}",
        )
        _assert_no_queryable_result(
            client,
            token,
            knowledge_base_id,
            marker,
            owner_user_id,
            "the cleared knowledge base",
        )
        _log(f"the purge of knowledge base {knowledge_base_id} left no result")

        # Rebuilding proves the purge removed this knowledge base's chunks only
        # and that the indexing pipeline still works afterwards.
        reindexed = client.post(
            f"/api/knowledge-documents/{document_id}/reindex",
            headers=_auth_headers(token),
        )
        _check(
            reindexed.status_code < 300,
            f"the rebuild entry was rejected: {reindexed.text}",
        )
        _wait_for_index_status(
            client,
            token,
            knowledge_base_id,
            document_id,
            "success",
            generation=generation + 1,
        )
        rebuilt = _public_list_chunks(client, token, knowledge_base_id)
        _assert_marker_listed(
            _listed_items(rebuilt),
            marker,
            f"the rebuilt knowledge base {knowledge_base_id}",
        )
        _log(f"rebuilding document {document_id} restored its chunks after the purge")
    finally:
        _delete_document(client, token, document_id)
        _delete_knowledge_base(client, token, knowledge_base_id)
        _delete_retrieval_resources(client, token, resource_name)


def _run_drop_scenario(client: httpx.Client, token: str, owner_user_id: int) -> None:
    """Dropping the physical index takes its chunks out of every reader."""

    _assert_admin_remote_gateways()
    resource_name = f"e2e-admin-drop-{uuid.uuid4().hex[:10]}"
    marker = f"WEGENT-E2E-ADMIN-DROP-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-ADMIN-DROP-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_attachment(client, token, marker)
    document = _create_document(client, token, knowledge_base_id, attachment_id)
    document_id = int(document["id"])
    try:
        _wait_for_index_status(client, token, knowledge_base_id, document_id, "success")
        _assert_marker_listed(
            _listed_items(_public_list_chunks(client, token, knowledge_base_id)),
            marker,
            f"the indexed knowledge base {knowledge_base_id}",
        )

        dropped = _public_drop_index(client, token, knowledge_base_id)
        _check(
            dropped.status_code == 200,
            f"the drop entry failed: {dropped.status_code} {dropped.text}",
        )
        _check(
            dropped.json().get("status") == "dropped",
            f"the drop entry must report a dropped index: {dropped.text}",
        )
        _log(f"dropped the index of knowledge base {knowledge_base_id}: {dropped.text}")

        after_runtime = _runtime_list_chunks(knowledge_base_id, owner_user_id)
        _check(
            after_runtime.status_code == 200
            and after_runtime.json().get("chunks") == [],
            f"the dropped index must hold no chunks: {after_runtime.status_code} "
            f"{after_runtime.text}",
        )
        after_list = _public_list_chunks(client, token, knowledge_base_id)
        _check(
            after_list.status_code == 200
            and int(after_list.json().get("total", 0)) == 0,
            f"the public listing must be empty after the drop: "
            f"{after_list.status_code} {after_list.text}",
        )
        _assert_no_queryable_result(
            client,
            token,
            knowledge_base_id,
            marker,
            owner_user_id,
            "the dropped knowledge base",
        )
        _log(f"the drop of knowledge base {knowledge_base_id} left no result")
    finally:
        _delete_document(client, token, document_id)
        _delete_knowledge_base(client, token, knowledge_base_id)
        _delete_retrieval_resources(client, token, resource_name)


def _run_admin_failure_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Runtime failures for the admin entries stay visible to the caller."""

    _assert_admin_remote_gateways()
    resource_name = f"e2e-admin-fail-{uuid.uuid4().hex[:10]}"
    marker = f"WEGENT-E2E-ADMIN-FAIL-{uuid.uuid4().hex[:8]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-ADMIN-FAIL-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_attachment(client, token, marker)
    document = _create_document(client, token, knowledge_base_id, attachment_id)
    document_id = int(document["id"])
    retriever_deleted = False
    try:
        _wait_for_index_status(client, token, knowledge_base_id, document_id, "success")

        # Delete the retriever the stored config points at. The Backend keeps the
        # knowledge base access check, but the remote path no longer resolves the
        # retriever, so the runtime reports the missing resource itself.
        deleted = client.delete(
            f"/api/retrievers/{resource_name}", headers=_auth_headers(token)
        )
        _check(
            deleted.status_code < 300,
            f"deleting the retriever failed: {deleted.text}",
        )
        retriever_deleted = True

        missing_retriever_calls: list[tuple[str, Callable[[], httpx.Response]]] = [
            (
                "listing chunks",
                lambda: _public_list_chunks(client, token, knowledge_base_id),
            ),
            (
                "purging the index",
                lambda: _public_purge_index(client, token, knowledge_base_id),
            ),
            (
                "dropping the index",
                lambda: _public_drop_index(client, token, knowledge_base_id),
            ),
        ]
        for operation, call in missing_retriever_calls:
            response = call()
            detail = _response_detail(response)
            # The runtime maps a missing resource to a bad request, while the
            # Backend's own retriever lookup would have answered 404. A local
            # fallback would have removed the chunks while reporting success.
            _check(
                response.status_code == 400 and detail,
                f"{operation} must surface the runtime failure: "
                f"{response.status_code} {response.text}",
            )
            _log(f"{operation} surfaced the runtime failure: detail={detail}")

        # A store that cannot be reached surfaces too, for the operations that
        # touch storage directly.
        _create_retriever_only(client, token, resource_name, QDRANT_URL)
        retriever_deleted = False
        _point_retriever_at(client, token, resource_name, UNREACHABLE_QDRANT_URL)
        unreachable_calls: list[tuple[str, Callable[[], httpx.Response]]] = [
            (
                "purging the index",
                lambda: _public_purge_index(client, token, knowledge_base_id),
            ),
            (
                "dropping the index",
                lambda: _public_drop_index(client, token, knowledge_base_id),
            ),
        ]
        for operation, call in unreachable_calls:
            response = call()
            detail = _response_detail(response)
            _check(
                response.status_code >= 500 and detail,
                f"{operation} must surface the unreachable store: "
                f"{response.status_code} {response.text}",
            )
            _log(f"{operation} surfaced the unreachable store: detail={detail}")

        # Restoring the store lets the same operations succeed again.
        _point_retriever_at(client, token, resource_name, QDRANT_URL)
        restored = _public_list_chunks(client, token, knowledge_base_id)
        _assert_marker_listed(
            _listed_items(restored),
            marker,
            f"the restored knowledge base {knowledge_base_id}",
        )
        purged = _public_purge_index(client, token, knowledge_base_id)
        _check(
            purged.status_code == 200,
            f"the retried purge must succeed: {purged.status_code} {purged.text}",
        )
        _log(
            f"the restored store served the chunk listing and the retried purge of "
            f"knowledge base {knowledge_base_id}"
        )
    finally:
        if retriever_deleted:
            _create_retriever_only(client, token, resource_name, QDRANT_URL)
        _point_retriever_at(client, token, resource_name, QDRANT_URL)
        _delete_document(client, token, document_id)
        _delete_knowledge_base(client, token, knowledge_base_id)
        _delete_retrieval_resources(client, token, resource_name)


def run_admin_scenarios(client: httpx.Client, token: str, owner_user_id: int) -> None:
    """Run the chunk listing, purge, drop, and failure admin scenarios."""

    _run_list_and_purge_scenario(client, token, owner_user_id)
    _run_drop_scenario(client, token, owner_user_id)
    _run_admin_failure_scenario(client, token, owner_user_id)
