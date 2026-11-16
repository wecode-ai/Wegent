# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Explicit continuation against real unavailable storage, in the existing suite."""

import uuid

import httpx
from knowledge_deleted_content_visibility import snapshot_document_points
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    QDRANT_URL,
    UNREACHABLE_QDRANT_URL,
    _auth_headers,
    _check,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_retrieval_resources,
    _document_row_exists,
    _internal_retrieve_knowledge_base,
    _point_retriever_at,
    _public_list_chunks,
    _upload_attachment,
    _wait_for_index_status,
)


def _continue(client: httpx.Client, token: str, path: str) -> None:
    headers = _auth_headers(token)
    failed = client.delete(path, headers=headers)
    _check(failed.status_code == 502, f"default deletion must fail: {failed.text}")
    _check(
        failed.json()["detail"].get("can_continue") is True,
        f"the failure must identify external cleanup: {failed.text}",
    )
    confirmed = client.delete(
        path,
        headers=headers,
        params={
            "continue_on_external_engine_failure": True,
            "include_cleanup_result": True,
        },
    )
    _check(confirmed.status_code == 200, f"continuation failed: {confirmed.text}")
    _check(
        confirmed.json()
        == {
            "content_deleted": True,
            "index_cleanup": "unconfirmed",
            "error_code": "external_engine_unavailable",
            "can_continue": False,
        },
        f"content and cleanup results must be separate: {confirmed.text}",
    )


def run_confirmed_deletion(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    name = f"e2e-continue-delete-{uuid.uuid4().hex[:10]}"
    _create_retrieval_resources(client, token, name, embedding_url=EMBEDDING_MODEL_URL)
    kb = _create_knowledge_base(client, token, name, name)
    kb_id = int(kb["id"])
    marker = f"CONTINUED-DELETE-{uuid.uuid4().hex[:8]}"
    attachment_id, _ = _upload_attachment(client, token, marker)
    document = _create_document(client, token, kb_id, attachment_id)
    doc_id = int(document["id"])
    try:
        _wait_for_index_status(client, token, kb_id, doc_id, "success")
        snapshot_document_points(kb_id, doc_id)
        _point_retriever_at(client, token, name, UNREACHABLE_QDRANT_URL)
        _continue(client, token, f"/api/knowledge-documents/{doc_id}")
        _check(not _document_row_exists(doc_id), "continued deletion must commit")

        _point_retriever_at(client, token, name, QDRANT_URL)
        snapshot_document_points(kb_id, doc_id)
        query = _internal_retrieve_knowledge_base(
            client, kb_id, marker, user_id=owner_user_id
        )
        _check(
            query.status_code == 200 and query.json().get("records") == [],
            f"residual points must not reappear after storage recovers: {query.text}",
        )
        listed = _public_list_chunks(client, token, kb_id)
        _check(
            listed.status_code == 200
            and listed.json()["items"] == []
            and listed.json()["total"] == 0,
            f"residual chunks must stay hidden: {listed.text}",
        )

        _point_retriever_at(client, token, name, UNREACHABLE_QDRANT_URL)
        _continue(client, token, f"/api/knowledge-bases/{kb_id}")
        absent = client.get(
            f"/api/knowledge-bases/{kb_id}", headers=_auth_headers(token)
        )
        _check(
            absent.status_code == 404, "continued knowledge base deletion must commit"
        )
    finally:
        _point_retriever_at(client, token, name, QDRANT_URL)
        if _document_row_exists(doc_id):
            response = client.delete(
                f"/api/knowledge-documents/{doc_id}", headers=_auth_headers(token)
            )
            _check(
                response.status_code < 300, f"fixture cleanup failed: {response.text}"
            )
        response = client.delete(
            f"/api/knowledge-bases/{kb_id}", headers=_auth_headers(token)
        )
        _check(
            response.status_code < 300 or response.status_code == 404,
            "fixture KB cleanup failed",
        )
        with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
            response = storage.delete(f"/collections/wegent_kb_{kb_id}")
            _check(
                response.status_code < 300 or response.status_code == 404,
                "fixture collection cleanup failed",
            )
        _delete_retrieval_resources(client, token, name)
