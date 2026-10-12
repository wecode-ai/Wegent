# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Temporary query settings must affect retrieval without changing saved settings."""

from __future__ import annotations

import uuid
from contextlib import ExitStack

import httpx
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    INTERNAL_SERVICE_TOKEN,
    _auth_headers,
    _check,
    _chunk_contents,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_document,
    _delete_knowledge_base,
    _document_chunks,
    _internal_retrieve_knowledge_base,
    _log,
    _upload_attachment,
    _wait_for_index_status,
)


def run_retrieval_parameters(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Use real stored chunks to prove top-K, threshold and saved-config isolation."""
    name = f"e2e-parameters-{uuid.uuid4().hex[:10]}"
    headers = _auth_headers(token)
    with ExitStack() as cleanup:
        _create_retrieval_resources(
            client,
            token,
            name,
            embedding_url=EMBEDDING_MODEL_URL,
            on_created=lambda path: cleanup.callback(
                _delete_resource, client, headers, path
            ),
        )
        kb = _create_knowledge_base(client, token, name, name)
        kb_id = int(kb["id"])
        cleanup.callback(_delete_knowledge_base, client, token, kb_id)
        config = {**kb["retrieval_config"], "top_k": 3, "score_threshold": 0.0}
        saved = client.put(
            f"/api/knowledge-bases/{kb_id}",
            headers=headers,
            json={"retrieval_config": config},
        )
        _check(saved.status_code == 200, "saving retrieval settings failed")
        document_ids = []
        # Identical source text gives four equally relevant real stored chunks.
        for _ in range(4):
            attachment_id, _ = _upload_attachment(client, token, name)
            document = _create_document(client, token, kb_id, attachment_id)
            document_id = int(document["id"])
            cleanup.callback(_delete_document, client, token, document_id)
            document_ids.append(document_id)
        for document_id in document_ids:
            _wait_for_index_status(client, token, kb_id, document_id, "success")
        query = _chunk_contents(_document_chunks(client, token, document_ids[0]))
        before = _saved_query(client, kb_id, query, owner_user_id)
        _check(len(before) == 3, "saved top-K=3 must return three real chunks")
        for top_k, threshold, text, expected in (
            (1, 0.0, query, 1),
            (4, 0.0, query, 4),
            (4, 0.99, "unrelated query for threshold rejection", 0),
        ):
            response = client.post(
                "/api/rag/retrieve",
                headers=headers,
                json={
                    "knowledge_id": str(kb_id),
                    "query": text,
                    "retriever_ref": {"name": name, "namespace": "default"},
                    "embedding_model_ref": {
                        "model_name": name,
                        "model_namespace": "default",
                    },
                    "top_k": top_k,
                    "score_threshold": threshold,
                    "retrieval_mode": "vector",
                },
            )
            _check(response.status_code == 200, "temporary retrieval failed")
            _check(
                len(response.json()["records"]) == expected,
                f"temporary top-K={top_k}, threshold={threshold} returned wrong count",
            )
        after = _saved_query(client, kb_id, query, owner_user_id)
        _check(len(after) == 3, "normal query must still use saved top-K=3")
        current = client.get(f"/api/knowledge-bases/{kb_id}", headers=headers)
        _check(current.status_code == 200, "reading saved settings failed")
        _check(
            current.json()["retrieval_config"] == saved.json()["retrieval_config"],
            "temporary query must not rewrite saved settings",
        )
        _log("temporary top-K/threshold and subsequent saved settings passed")


def _saved_query(
    client: httpx.Client, kb_id: int, query: str, owner_user_id: int
) -> list[dict]:
    response = _internal_retrieve_knowledge_base(
        client,
        kb_id,
        query,
        user_id=owner_user_id,
        max_results=10,
    )
    _check(response.status_code == 200, "query with saved settings failed")
    return response.json()["records"]


def run_qa_retrieval(client: httpx.Client, token: str, owner_user_id: int) -> None:
    """A QA document works with automatic hints and the short-document route."""
    name = f"e2e-qa-{uuid.uuid4().hex[:10]}"
    content = (
        "Q1: 蓝盒的验收口令是什么？\nA: QA-417。蓝盒仓库在青岛。\n\n"
        "Q2: 蓝盒值班时间是什么？\nA: 值班时间是09:17。"
    )
    headers = _auth_headers(token)
    with ExitStack() as cleanup:
        _create_retrieval_resources(
            client,
            token,
            name,
            embedding_url=EMBEDDING_MODEL_URL,
            on_created=lambda path: cleanup.callback(
                _delete_resource, client, headers, path
            ),
        )
        kb = _create_knowledge_base(client, token, name, name)
        kb_id = int(kb["id"])
        cleanup.callback(_delete_knowledge_base, client, token, kb_id)
        upload = client.post(
            "/api/attachments/upload",
            headers=headers,
            files={"file": ("acceptance-qa.md", content.encode(), "text/markdown")},
        )
        _check(upload.status_code == 200, "uploading QA source failed")
        document = _create_document(client, token, kb_id, int(upload.json()["id"]))
        document_id = int(document["id"])
        cleanup.callback(_delete_document, client, token, document_id)
        _wait_for_index_status(client, token, kb_id, document_id, "success")
        # No caller hints: the runtime chooses the QA query plan itself.
        query = "蓝盒的验收口令是什么？"
        indexed = _saved_query(client, kb_id, query, owner_user_id)
        _check(
            any(
                "QA-417" in row["content"]
                and row.get("metadata", {}).get("node_role") == "qa_pair"
                for row in indexed
            ),
            "QA query without hints must return a real QA pair",
        )
        direct = client.post(
            "/api/internal/rag/retrieve",
            headers={"Authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}"},
            json={
                "query": query,
                "user_id": owner_user_id,
                "knowledge_base_ids": [kb_id],
                "document_ids": [document_id],
                "route_mode": "auto",
                "max_results": 5,
                "runtime_context": {"context_window": 32768},
            },
        )
        _check(direct.status_code == 200, "automatic short-document route failed")
        _check(
            any(content == row["content"] for row in direct.json()["records"]),
            f"short QA automatic route must expose its complete source text: {direct.json()}",
        )
        _log("QA query without hints and short-document automatic route passed")


def _delete_resource(client: httpx.Client, headers: dict[str, str], path: str) -> None:
    response = client.delete(path, headers=headers)
    _check(response.status_code < 300, f"resource cleanup failed: {path}")
