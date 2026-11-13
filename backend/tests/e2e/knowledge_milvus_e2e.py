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
from knowledge_milvus_readiness import run_readiness_scenarios
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
    _retriever_payload,
    _runtime_list_chunks,
    _upload_attachment,
    _wait_for_index_status,
)


def run_payload_scenarios(
    client: httpx.Client,
    token: str,
    user_id: int,
    knowledge_base_id: int,
    name: str,
    milvus_url: str,
) -> None:
    """Use real storage and workers for bounded writes and final error state."""
    document_ids: list[int] = []

    def set_budget(max_bytes: int, headroom: int) -> None:
        payload = _retriever_payload(name, milvus_url, storage_type="milvus")
        payload["spec"]["storageConfig"]["ext"] = {
            "max_batch_bytes": max_bytes,
            "batch_headroom_bytes": headroom,
            "batch_size": 3,
        }
        response = client.put(
            f"/api/retrievers/{name}", headers=_auth_headers(token), json=payload
        )
        _check(response.status_code < 300, f"setting write budget: {response.text}")

    def upload(body: str) -> int:
        attachment_id, _ = _upload_attachment(client, token, body)
        row = _create_document(client, token, knowledge_base_id, attachment_id)
        document_id = int(row["id"])
        document_ids.append(document_id)
        return document_id

    try:
        set_budget(24000, 2000)
        markers = [f"bounded{uuid.uuid4().hex}" for _ in range(24)]
        body = "\n\n".join(marker + " payload" * 150 for marker in markers)
        document_id = upload(body)
        _wait_for_index_status(
            client, token, knowledge_base_id, document_id, "success", generation=1
        )
        chunks = _runtime_list_chunks(knowledge_base_id, user_id)
        _check(chunks.status_code == 200, f"reading bounded writes: {chunks.text}")
        for marker in markers:
            _check(marker in chunks.text, f"bounded writes lost content: {marker}")

        # The configured budget is below one complete encoded row, even for a
        # small file. Nothing except the model endpoint is simulated here.
        set_budget(128, 0)
        failed_id = upload(f"oversized{uuid.uuid4().hex}")
        failed = _wait_for_index_status(
            client, token, knowledge_base_id, failed_id, "failed", generation=1
        )
        error = failed.get("processing_error") or {}
        _check(error.get("code") == "milvus_row_too_large", str(failed))
        _check(error.get("retryable") is False, str(failed))
        _check("not truncated" in error.get("message", ""), str(failed))
        chunks = _runtime_list_chunks(knowledge_base_id, user_id)
        _check(chunks.status_code == 200, f"reading after failed write: {chunks.text}")
        for marker in markers:
            _check(marker in chunks.text, "failed write damaged an indexed document")
    finally:
        for document_id in reversed(document_ids):
            _delete_document(client, token, document_id)
        set_budget(1024 * 1024, 64 * 1024)


def run() -> None:
    _require_remote_services()
    run_readiness_scenarios()
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
        run_payload_scenarios(
            client, token, user_id, knowledge_base_id, name, milvus_url
        )
    print("Milvus concurrent creation, retrieval, rebuild and deletion E2E passed")


if __name__ == "__main__":
    run()
