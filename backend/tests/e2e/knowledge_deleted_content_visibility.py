# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Residual-index checks inside the existing real Qdrant deletion scenario."""

from typing import Any

import httpx
from knowledge_remote_index_support import (
    QDRANT_URL,
    _assert_no_record_for_document,
    _assert_records_reference_document,
    _auth_headers,
    _check,
    _internal_retrieve_knowledge_base,
    _log,
    _public_list_chunks,
)


def snapshot_document_points(knowledge_base_id: int, document_id: int) -> list[dict]:
    """Copy real points, including vectors, before product deletion removes them."""
    with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
        response = storage.post(
            f"/collections/wegent_kb_{knowledge_base_id}/points/scroll",
            json={
                "filter": {
                    "must": [
                        {
                            "key": "knowledge_id",
                            "match": {"value": str(knowledge_base_id)},
                        },
                        {"key": "doc_ref", "match": {"value": str(document_id)}},
                    ]
                },
                "limit": 100,
                "with_payload": True,
                "with_vector": True,
            },
        )
        response.raise_for_status()
        result = response.json()["result"]
    _check(result["points"], "the deletion fixture must have real external points")
    _check(
        result.get("next_page_offset") is None, "the small fixture must fit one page"
    )
    return result["points"]


def assert_residual_points_are_hidden(
    client: httpx.Client,
    token: str,
    *,
    knowledge_base_id: int,
    deleted_document_id: int,
    sibling_document_id: int,
    owner_user_id: int,
    sibling_marker: str,
    points: list[dict[str, Any]],
) -> None:
    """A real late write stays stored externally but cannot enter new reads."""
    with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
        response = storage.put(
            f"/collections/wegent_kb_{knowledge_base_id}/points",
            params={"wait": "true"},
            json={
                "points": [
                    {key: point[key] for key in ("id", "vector", "payload")}
                    for point in points
                ]
            },
        )
        response.raise_for_status()
    snapshot_document_points(knowledge_base_id, deleted_document_id)

    query = _internal_retrieve_knowledge_base(
        client, knowledge_base_id, sibling_marker, user_id=owner_user_id
    )
    _check(query.status_code == 200, f"residual-index query failed: {query.text}")
    records = query.json().get("records", [])
    _assert_no_record_for_document(records, deleted_document_id)
    _assert_records_reference_document(
        records, knowledge_base_id, sibling_document_id, sibling_marker
    )

    listed = _public_list_chunks(client, token, knowledge_base_id, page_size=1)
    _check(listed.status_code == 200, f"residual chunk listing failed: {listed.text}")
    result = listed.json()
    _check(result["items"], "the surviving sibling must remain listed")
    _check(
        all(
            str(item["doc_ref"]) == str(sibling_document_id) for item in result["items"]
        ),
        f"pagination must exclude the residual document: {result}",
    )
    expected_total = len(
        snapshot_document_points(knowledge_base_id, sibling_document_id)
    )
    _check(result["total"] == expected_total, f"total must exclude residuals: {result}")
    for suffix in ("", "/detail", "/chunks", "/chunks/0"):
        read = client.get(
            f"/api/knowledge-documents/{deleted_document_id}{suffix}",
            headers=_auth_headers(token),
        )
        _check(read.status_code == 404, f"deleted document read must fail: {read.text}")
    _log(
        "real residual points remained external and were hidden from new product reads"
    )
