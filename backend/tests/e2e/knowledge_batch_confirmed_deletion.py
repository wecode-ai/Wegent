# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real batch continuation and isolation in one fixture-owned shared collection."""

import uuid

import httpx
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    QDRANT_URL,
    UNREACHABLE_QDRANT_URL,
    _assert_records_reference_document,
    _auth_headers,
    _check,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_retrieval_resources,
    _document_row_exists,
    _internal_retrieve_knowledge_base,
    _public_list_chunks,
    _retriever_payload,
    _upload_attachment,
    _wait_for_index_status,
)


def run_batch_confirmed_deletion(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    name = f"e2e-batch-delete-{uuid.uuid4().hex[:10]}"
    collection = f"batch_{uuid.uuid4().hex}"
    _create_retrieval_resources(client, token, name, embedding_url=EMBEDDING_MODEL_URL)

    def point(url: str) -> None:
        payload = _retriever_payload(name, url)
        payload["spec"]["storageConfig"]["indexStrategy"] = {
            "mode": "fixed",
            "fixedName": collection,
        }
        response = client.put(
            f"/api/retrievers/{name}", headers=_auth_headers(token), json=payload
        )
        _check(
            response.status_code < 300,
            f"fixture retriever update failed: {response.text}",
        )

    point(QDRANT_URL)
    target = int(_create_knowledge_base(client, token, name, name)["id"])
    peer = int(_create_knowledge_base(client, token, f"{name}-peer", name)["id"])
    documents: list[tuple[int, int]] = []
    try:
        for kb_id, marker in (
            (target, "BATCH-A"),
            (target, "BATCH-B"),
            (peer, "BATCH-PEER"),
        ):
            attachment, _ = _upload_attachment(client, token, marker)
            doc_id = int(_create_document(client, token, kb_id, attachment)["id"])
            documents.append((kb_id, doc_id))
            _wait_for_index_status(client, token, kb_id, doc_id, "success")

        point(UNREACHABLE_QDRANT_URL)
        ids = [documents[0][1], documents[1][1]]
        first = client.post(
            "/api/knowledge-documents/batch/delete",
            headers=_auth_headers(token),
            params={"include_cleanup_result": True},
            json={"document_ids": [*ids, ids[0], -1]},
        )
        _check(first.status_code == 200, f"batch result unavailable: {first.text}")
        data = first.json()
        _check(
            data["success_count"] == 0 and data["failed_count"] == 3,
            f"batch must deduplicate: {data}",
        )
        eligible = [
            item["document_id"] for item in data["items"] if item["can_continue"]
        ]
        _check(eligible == ids, f"only external failures can continue: {data}")
        second = client.post(
            "/api/knowledge-documents/batch/delete",
            headers=_auth_headers(token),
            params={"continue_on_external_engine_failure": True},
            json={"document_ids": eligible},
        )
        _check(second.status_code == 200, f"batch continuation failed: {second.text}")
        data = second.json()
        _check(
            data["success_count"] == 2
            and data["failed_count"] == 0
            and data["unconfirmed_count"] == 2,
            f"committed content and uncertain cleanup must be distinct: {data}",
        )
        _check(
            all(not _document_row_exists(doc_id) for doc_id in ids),
            "batch content must be deleted",
        )

        point(QDRANT_URL)
        with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
            response = storage.post(
                f"/collections/{collection}/points/scroll",
                json={
                    "filter": {
                        "must": [
                            {"key": "knowledge_id", "match": {"value": str(target)}}
                        ]
                    },
                    "limit": 100,
                    "with_payload": True,
                },
            )
            response.raise_for_status()
            refs = {
                row["payload"]["doc_ref"] for row in response.json()["result"]["points"]
            }
            _check(
                set(map(str, ids)) <= refs, "real external remnants must still exist"
            )
        listed = _public_list_chunks(client, token, target)
        _check(
            listed.status_code == 200 and listed.json()["total"] == 0,
            "new chunk reads must hide remnants",
        )
        query = _internal_retrieve_knowledge_base(
            client, target, "BATCH-A", user_id=owner_user_id
        )
        _check(
            query.status_code == 200 and query.json()["records"] == [],
            "new retrieval must hide remnants",
        )
        peer_query = _internal_retrieve_knowledge_base(
            client, peer, "BATCH-PEER", user_id=owner_user_id
        )
        _check(
            peer_query.status_code == 200 and peer_query.json()["records"],
            "the shared-storage peer must remain searchable",
        )
        _assert_records_reference_document(
            peer_query.json()["records"], peer, documents[2][1], "BATCH-PEER"
        )
        _check(
            _document_row_exists(documents[2][1]),
            "the peer document must remain present",
        )
    finally:
        point(QDRANT_URL)
        for kb_id, doc_id in documents:
            if _document_row_exists(doc_id):
                response = client.delete(
                    f"/api/knowledge-documents/{doc_id}", headers=_auth_headers(token)
                )
                _check(
                    response.status_code < 300,
                    f"fixture document cleanup failed: {response.text}",
                )
        for kb_id in (target, peer):
            response = client.delete(
                f"/api/knowledge-bases/{kb_id}", headers=_auth_headers(token)
            )
            _check(
                response.status_code < 300,
                f"fixture KB cleanup failed: {response.text}",
            )
        with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
            response = storage.delete(f"/collections/{collection}")
            _check(
                response.status_code < 300, "fixture-owned collection cleanup failed"
            )
        _delete_retrieval_resources(client, token, name)
