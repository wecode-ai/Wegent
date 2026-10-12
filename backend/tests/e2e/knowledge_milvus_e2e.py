# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Real Milvus lifecycle regression; only the embedding model is simulated."""

from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from threading import Lock

import httpx
from knowledge_remote_index import _rebuild_through_entry, _rebuild_with_new_content
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    MOCK_MODEL_SERVER_URL,
    _assert_records_reference_document,
    _auth_headers,
    _check,
    _create_client,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_document,
    _delete_knowledge_base,
    _internal_retrieve,
    _login,
    _require_remote_services,
    _runtime_list_chunks,
    _upload_attachment,
    _wait_for_index_status,
)


def run() -> None:
    _require_remote_services()
    milvus_url = os.environ["E2E_MILVUS_URL"]
    name = f"milvus-e2e-{uuid.uuid4().hex[:12]}"
    with _create_client() as client, ExitStack() as cleanup:
        token, user_id = _login(client)
        remaining_documents: set[int] = set()
        document_lock = Lock()

        def delete_resource(path: str) -> None:
            response = client.delete(path, headers=_auth_headers(token))
            _check(response.status_code < 300, f"cleanup failed: {response.text}")

        def delete_document(document_id: int) -> None:
            with document_lock:
                if document_id not in remaining_documents:
                    return
            _delete_document(client, token, document_id)
            with document_lock:
                remaining_documents.remove(document_id)

        _create_retrieval_resources(
            client,
            token,
            name,
            embedding_url=EMBEDDING_MODEL_URL,
            storage_type="milvus",
            storage_url=milvus_url,
            embedding_model_id=name,
            on_created=lambda path: cleanup.callback(delete_resource, path),
        )
        kb = _create_knowledge_base(client, token, name, name)
        knowledge_base_id = int(kb["id"])
        cleanup.callback(_delete_knowledge_base, client, token, knowledge_base_id)
        markers = [f"milvusparity{uuid.uuid4().hex}" for _ in range(4)]

        def upload(marker: str) -> int:
            with _create_client() as worker_client:
                attachment_id, _ = _upload_attachment(worker_client, token, marker)
                document = _create_document(
                    worker_client,
                    token,
                    knowledge_base_id,
                    attachment_id,
                    name=f"{marker}.md",
                )
                document_id = int(document["id"])
                with document_lock:
                    remaining_documents.add(document_id)
                    cleanup.callback(delete_document, document_id)
                return document_id

        def embedding_barrier(action: str) -> dict:
            result = httpx.post(
                f"{MOCK_MODEL_SERVER_URL}/embedding-control/barrier",
                json={"model": name, "action": action},
                timeout=10,
            )
            _check(result.status_code == 200, f"embedding barrier: {result.text}")
            return result.json()

        embedding_barrier("arm")
        cleanup.callback(embedding_barrier, "clear")
        # No collection exists yet: all four first uploads race naturally.
        with ThreadPoolExecutor(max_workers=4) as pool:
            document_ids = list(pool.map(upload, markers))
        for document_id in document_ids:
            _wait_for_index_status(
                client,
                token,
                knowledge_base_id,
                document_id,
                "success",
                generation=1,
            )

        barrier = embedding_barrier("status")
        _check(
            barrier
            == {"arrivals": 4, "peak_pending": 4, "released": True, "timed_out": False},
            f"index workers did not overlap: {barrier}",
        )
        for mode in ("vector", "keyword", "hybrid"):
            changed = client.put(
                f"/api/knowledge-bases/{knowledge_base_id}",
                headers=_auth_headers(token),
                json={"retrieval_config": {"retrieval_mode": mode}},
            )
            _check(changed.status_code == 200, f"setting {mode}: {changed.text}")
            for document_id, marker in zip(document_ids, markers):
                result = _internal_retrieve(
                    client,
                    knowledge_base_id,
                    document_id,
                    marker,
                    user_id=user_id,
                )
                _check(result.status_code == 200, f"{mode}: {result.text}")
                _assert_records_reference_document(
                    result.json().get("records", []),
                    knowledge_base_id,
                    document_id,
                    marker,
                )

        restored = client.put(
            f"/api/knowledge-bases/{knowledge_base_id}",
            headers=_auth_headers(token),
            json={"retrieval_config": {"retrieval_mode": "vector"}},
        )
        _check(restored.status_code == 200, f"restoring vector: {restored.text}")
        new_marker = f"milvusrebuilt{uuid.uuid4().hex}"
        _, generation = _rebuild_with_new_content(
            client,
            token,
            knowledge_base_id,
            document_ids[0],
            user_id,
            previous_generation=1,
            marker_a=markers[0],
            marker_b=new_marker,
        )
        _rebuild_through_entry(
            client,
            token,
            knowledge_base_id,
            document_ids[0],
            previous_generation=generation,
            marker_b=new_marker,
        )
        delete_document(document_ids[1])
        stored = _runtime_list_chunks(knowledge_base_id, user_id)
        _check(stored.status_code == 200, f"listing Milvus chunks: {stored.text}")
        # Query the complete real store, not just the surviving document scope.
        content = str(stored.json())
        _check(markers[0] not in content, "old content remains after rebuild")
        _check(markers[1] not in content, "deleted document remains in Milvus")
        for marker in (new_marker, *markers[2:]):
            _check(marker in content, f"surviving document missing: {marker}")
    print("Milvus concurrent creation, retrieval, rebuild and deletion E2E passed")


if __name__ == "__main__":
    run()
