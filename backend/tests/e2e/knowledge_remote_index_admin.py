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

The Backend keeps the retriever access verdict for the remote path while the
runtime resolves the execution configuration itself, so a knowledge base whose
retriever was removed is refused before any remote request, and the failure
scenario pins both that refusal and the runtime failures the Backend cannot see.
"""

from __future__ import annotations

import uuid
from typing import Callable

import httpx
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    QDRANT_URL,
    UNREACHABLE_QDRANT_URL,
    _assert_local_operations_are_refused,
    _assert_remote_gateways,
    _auth_headers,
    _check,
    _chunk_contents,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _create_retriever_only,
    _delete_scenario_fixtures,
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

AdminCall = Callable[[], httpx.Response]


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


def _assert_empty_query_result(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    marker: str,
    owner_user_id: int,
    context: str,
) -> None:
    """The knowledge base query must answer with no record after the operation."""

    query = _internal_retrieve_knowledge_base(
        client, knowledge_base_id, marker, user_id=owner_user_id
    )
    _check(
        query.status_code == 200,
        f"{context} must still answer a query: {query.status_code} {query.text}",
    )
    records = query.json().get("records", [])
    _check(
        records == [],
        f"{context} must leave nothing queryable: {query.text}",
    )
    _log(f"{context}: the knowledge base query returned no record")


def _assert_dropped_query_result(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    marker: str,
    owner_user_id: int,
    context: str,
) -> None:
    """A dropped index either answers empty or fails visibly, never stale."""

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
        f"{context} must either answer empty or fail visibly: "
        f"{query.status_code} {query.text}",
    )
    _log(
        f"{context}: the knowledge base query failed visibly with "
        f"{query.status_code} {detail}"
    )


def _create_indexed_document(
    client: httpx.Client, token: str, scenario: str, marker: str
) -> tuple[str, int, int, int]:
    """Create one indexed single-document knowledge base for a scenario."""

    resource_name = f"e2e-{scenario}-{uuid.uuid4().hex[:10]}"
    _create_retrieval_resources(
        client, token, resource_name, embedding_url=EMBEDDING_MODEL_URL
    )
    knowledge_base = _create_knowledge_base(
        client, token, f"E2E-KB-{scenario.upper()}-{resource_name}", resource_name
    )
    knowledge_base_id = int(knowledge_base["id"])
    attachment_id, _ = _upload_attachment(client, token, marker)
    document = _create_document(client, token, knowledge_base_id, attachment_id)
    document_id = int(document["id"])
    indexed = _wait_for_index_status(
        client, token, knowledge_base_id, document_id, "success"
    )
    _log(
        f"{scenario} scenario document {document_id} indexed in knowledge base "
        f"{knowledge_base_id}"
    )
    return (
        resource_name,
        knowledge_base_id,
        document_id,
        int(indexed["index_generation"]),
    )


def _assert_listed_chunks(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    marker: str,
    context: str,
) -> None:
    """The public chunk listing must expose the indexed content."""

    listed = _public_list_chunks(client, token, knowledge_base_id)
    _check(
        int(listed.json().get("total", 0)) > 0,
        f"{context} must list chunks: {listed.text}",
    )
    _assert_marker_listed(_listed_items(listed), marker, context)


def _assert_runtime_chunks(
    knowledge_base_id: int, owner_user_id: int, marker: str
) -> None:
    """The runtime store itself must hold the indexed content."""

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


def _assert_no_chunks(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    owner_user_id: int,
    context: str,
) -> None:
    """Neither the runtime store nor the public entry may list chunks."""

    after_runtime = _runtime_list_chunks(knowledge_base_id, owner_user_id)
    _check(
        after_runtime.status_code == 200 and after_runtime.json().get("chunks") == [],
        f"{context} must leave the runtime store empty: "
        f"{after_runtime.status_code} {after_runtime.text}",
    )
    after_list = _public_list_chunks(client, token, knowledge_base_id)
    _check(
        after_list.status_code == 200 and int(after_list.json().get("total", 0)) == 0,
        f"{context} must leave the public listing empty: "
        f"{after_list.status_code} {after_list.text}",
    )


def _rebuild_and_assert_chunks(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    document_id: int,
    marker: str,
    generation: int,
) -> None:
    """Rebuilding must restore exactly the chunks the purge removed."""

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
    _assert_listed_chunks(
        client, token, knowledge_base_id, marker, "the rebuilt knowledge base"
    )
    _log(f"rebuilding document {document_id} restored its chunks after the purge")


def _purge_and_assert_empty(
    client: httpx.Client,
    token: str,
    knowledge_base_id: int,
    owner_user_id: int,
) -> None:
    """The purge entry must report its removal and leave no chunk behind."""

    purged = _public_purge_index(client, token, knowledge_base_id)
    _check(
        purged.status_code == 200,
        f"the purge entry failed: {purged.status_code} {purged.text}",
    )
    body = purged.json()
    _check(
        body.get("status") == "deleted" and int(body.get("deleted_chunks", 0)) > 0,
        f"the purge entry must remove the indexed chunks: {purged.text}",
    )
    _log(f"purged knowledge base {knowledge_base_id}: {body}")
    _assert_no_chunks(
        client, token, knowledge_base_id, owner_user_id, "the purged index"
    )


def _assert_admin_calls_fail(
    calls: list[tuple[str, AdminCall]],
    expected_status: int,
    context: str,
) -> None:
    """Each admin entry must answer with the expected failure and a detail."""

    for operation, call in calls:
        response = call()
        detail = _response_detail(response)
        _check(
            response.status_code == expected_status and detail,
            f"{operation} must surface the {context}: "
            f"{response.status_code} {response.text}",
        )
        _log(f"{operation} surfaced the {context}: detail={detail}")


def _admin_calls(
    client: httpx.Client, token: str, knowledge_base_id: int
) -> list[tuple[str, AdminCall]]:
    """The three public index-management entries for one knowledge base."""

    return [
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


def _delete_retriever(client: httpx.Client, token: str, resource_name: str) -> None:
    """Remove the retriever the stored knowledge base config points at."""

    deleted = client.delete(
        f"/api/retrievers/{resource_name}", headers=_auth_headers(token)
    )
    _check(
        deleted.status_code < 300,
        f"deleting the retriever failed: {deleted.text}",
    )


def _run_list_and_purge_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Listing exposes the runtime's chunks, and purging removes exactly them."""

    _assert_remote_gateways()
    marker = f"WEGENT-E2E-ADMIN-PURGE-{uuid.uuid4().hex[:8]}"
    resource_name, knowledge_base_id, document_id, generation = (
        _create_indexed_document(client, token, "admin", marker)
    )
    try:
        _assert_local_operations_are_refused(
            knowledge_base_id, document_id, resource_name, owner_user_id
        )
        _assert_listed_chunks(
            client, token, knowledge_base_id, marker, "the public chunk listing"
        )
        # The runtime store holds the same chunks, so the listing is not served
        # from a Backend-side copy.
        _assert_runtime_chunks(knowledge_base_id, owner_user_id, marker)
        _log(
            f"the runtime store and the public entry listed the chunks of "
            f"knowledge base {knowledge_base_id}"
        )
        _purge_and_assert_empty(client, token, knowledge_base_id, owner_user_id)
        _assert_empty_query_result(
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
        _rebuild_and_assert_chunks(
            client, token, knowledge_base_id, document_id, marker, generation
        )
    finally:
        _delete_scenario_fixtures(
            client,
            token,
            document_id=document_id,
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
        )


def _run_drop_scenario(client: httpx.Client, token: str, owner_user_id: int) -> None:
    """Dropping the physical index takes its chunks out of every reader."""

    _assert_remote_gateways()
    marker = f"WEGENT-E2E-ADMIN-DROP-{uuid.uuid4().hex[:8]}"
    resource_name, knowledge_base_id, document_id, _generation = (
        _create_indexed_document(client, token, "admin-drop", marker)
    )
    try:
        _assert_listed_chunks(
            client,
            token,
            knowledge_base_id,
            marker,
            f"the indexed knowledge base {knowledge_base_id}",
        )

        dropped = _public_drop_index(client, token, knowledge_base_id)
        _check(
            dropped.status_code == 200 and dropped.json().get("status") == "dropped",
            f"the drop entry must report a dropped index: {dropped.text}",
        )
        _log(f"dropped the index of knowledge base {knowledge_base_id}: {dropped.text}")

        _assert_no_chunks(
            client, token, knowledge_base_id, owner_user_id, "the dropped index"
        )
        _assert_dropped_query_result(
            client,
            token,
            knowledge_base_id,
            marker,
            owner_user_id,
            "the dropped knowledge base",
        )
        _log(f"the drop of knowledge base {knowledge_base_id} left no result")
    finally:
        _delete_scenario_fixtures(
            client,
            token,
            document_id=document_id,
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
        )


def _run_admin_failure_scenario(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Runtime failures for the admin entries stay visible to the caller."""

    _assert_remote_gateways()
    marker = f"WEGENT-E2E-ADMIN-FAIL-{uuid.uuid4().hex[:8]}"
    resource_name, knowledge_base_id, document_id, _generation = (
        _create_indexed_document(client, token, "admin-fail", marker)
    )
    retriever_deleted = False
    try:
        # Delete the retriever the stored config points at. The Backend keeps the
        # owner's retriever access verdict for the remote path, so every entry is
        # refused before a request leaves the Backend and the runtime store keeps
        # the chunks untouched.
        _delete_retriever(client, token, resource_name)
        retriever_deleted = True
        _assert_admin_calls_fail(
            _admin_calls(client, token, knowledge_base_id),
            404,
            "missing retriever",
        )
        _create_retriever_only(client, token, resource_name, QDRANT_URL)
        retriever_deleted = False
        _assert_runtime_chunks(knowledge_base_id, owner_user_id, marker)
        _log(
            f"the refused entries left the runtime store of knowledge base "
            f"{knowledge_base_id} untouched"
        )

        # A store that cannot be reached is a runtime failure the Backend cannot
        # see: the retriever record is authorized, so the request reaches the
        # runtime and its storage failure must surface for the mutating entries.
        _point_retriever_at(client, token, resource_name, UNREACHABLE_QDRANT_URL)
        _assert_admin_calls_fail(
            _admin_calls(client, token, knowledge_base_id)[1:],
            500,
            "unreachable store",
        )

        # Restoring the store lets the same operations succeed again.
        _point_retriever_at(client, token, resource_name, QDRANT_URL)
        _assert_listed_chunks(
            client, token, knowledge_base_id, marker, "the restored knowledge base"
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
        _delete_scenario_fixtures(
            client,
            token,
            document_id=document_id,
            knowledge_base_id=knowledge_base_id,
            resource_name=resource_name,
        )


def run_admin_scenarios(client: httpx.Client, token: str, owner_user_id: int) -> None:
    """Run the chunk listing, purge, drop, and failure admin scenarios."""

    _run_list_and_purge_scenario(client, token, owner_user_id)
    _run_drop_scenario(client, token, owner_user_id)
    _run_admin_failure_scenario(client, token, owner_user_id)
