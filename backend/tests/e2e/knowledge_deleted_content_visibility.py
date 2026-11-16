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


def _install_residual_window(
    storage: httpx.Client,
    knowledge_base_id: int,
    sibling_document_id: int,
    deleted_points: list[dict[str, Any]],
) -> dict[str, Any]:
    """Reuse indexed vectors to put live chunks after 10001 real remnants."""
    live = snapshot_document_points(knowledge_base_id, sibling_document_id)[0]
    path = f"/collections/wegent_kb_{knowledge_base_id}/points"
    knowledge_filter = {
        "must": [{"key": "knowledge_id", "match": {"value": str(knowledge_base_id)}}]
    }
    response = storage.post(
        f"{path}/delete", params={"wait": "true"}, json={"filter": knowledge_filter}
    )
    response.raise_for_status()
    for start in range(1, 10002, 500):
        points = [
            {
                "id": index,
                "vector": deleted_points[0]["vector"],
                "payload": deleted_points[0]["payload"],
            }
            for index in range(start, min(start + 500, 10002))
        ]
        response = storage.put(path, params={"wait": "true"}, json={"points": points})
        response.raise_for_status()
    points = [
        {
            "id": 10002 + index,
            "vector": live["vector"],
            "payload": {**live["payload"], "doc_ref": reference, "chunk_index": index},
        }
        for index, reference in enumerate(
            (str(sibling_document_id), f"doc_{sibling_document_id}")
        )
    ]
    foreign = {
        "id": 10004,
        "vector": live["vector"],
        "payload": {**live["payload"], "knowledge_id": "foreign"},
    }
    response = storage.put(
        path, params={"wait": "true"}, json={"points": [*points, foreign]}
    )
    response.raise_for_status()
    _assert_raw_residual_window(
        storage, path, knowledge_filter, deleted_points[0]["payload"]["doc_ref"]
    )
    return foreign


def _assert_raw_residual_window(
    storage: httpx.Client, path: str, knowledge_filter: dict, deleted_ref: str
) -> None:
    """Establish that the unscoped scan cannot reach either live chunk."""
    raw = storage.post(
        f"{path}/scroll",
        json={
            "filter": knowledge_filter,
            "limit": 10000,
            "with_payload": True,
            "with_vector": False,
        },
    )
    raw.raise_for_status()
    window = raw.json()["result"]
    _check(
        len(window["points"]) == 10000 and window["next_page_offset"] is not None,
        "raw Qdrant window must truncate before both live chunks",
    )
    _check(
        all(point["payload"]["doc_ref"] == deleted_ref for point in window["points"]),
        "raw window must contain only deleted remnants",
    )


def _set_document_status(
    client: httpx.Client, token: str, document_id: int, status: str
) -> None:
    response = client.put(
        f"/api/knowledge-documents/{document_id}",
        headers=_auth_headers(token),
        json={"status": status},
    )
    _check(
        response.status_code == 200 and response.json()["status"] == status,
        f"the fixture document must become {status}",
    )


def _assert_live_pages(
    client: httpx.Client, token: str, knowledge_id: int, document_id: int
) -> None:
    _set_document_status(client, token, document_id, "disabled")
    try:
        seen = []
        for page in (1, 2, 3):
            listed = _public_list_chunks(
                client, token, knowledge_id, page=page, page_size=1
            )
            _check(
                listed.status_code == 200,
                f"residual chunk listing failed: {listed.text}",
            )
            result = listed.json()
            _check(result["total"] == 2, f"count must exclude 10001 remnants: {result}")
            _check(
                len(result["items"]) == (1 if page < 3 else 0),
                "live chunks must page without remnants",
            )
            seen.extend(result["items"])
        _check(
            {item["doc_ref"] for item in seen}
            == {str(document_id), f"doc_{document_id}"},
            "both live reference encodings must survive the native limit",
        )
        _check(
            all(item["metadata"]["knowledge_id"] == str(knowledge_id) for item in seen),
            "foreign knowledge points must remain isolated",
        )
    finally:
        _set_document_status(client, token, document_id, "enabled")


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
    path = f"/collections/wegent_kb_{knowledge_base_id}/points"
    with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
        try:
            foreign = _install_residual_window(
                storage, knowledge_base_id, sibling_document_id, points
            )
            query = _internal_retrieve_knowledge_base(
                client, knowledge_base_id, sibling_marker, user_id=owner_user_id
            )
            _check(
                query.status_code == 200, f"residual-index query failed: {query.text}"
            )
            records = query.json().get("records", [])
            _assert_no_record_for_document(records, deleted_document_id)
            _assert_records_reference_document(
                records, knowledge_base_id, sibling_document_id, sibling_marker
            )
            _assert_live_pages(client, token, knowledge_base_id, sibling_document_id)
            response = storage.post(
                path,
                json={
                    "ids": [foreign["id"]],
                    "with_payload": True,
                    "with_vector": True,
                },
            )
            response.raise_for_status()
            stored = response.json()["result"]
            _check(
                len(stored) == 1
                and all(stored[0][key] == value for key, value in foreign.items()),
                "foreign stored point must remain unchanged",
            )
            for suffix in ("", "/detail", "/chunks", "/chunks/0"):
                read = client.get(
                    f"/api/knowledge-documents/{deleted_document_id}{suffix}",
                    headers=_auth_headers(token),
                )
                _check(
                    read.status_code == 404,
                    f"deleted document read must fail: {read.text}",
                )
            _log(
                "10001 real residual points preceded live chunks; native Qdrant pages, count and knowledge isolation passed"
            )
        finally:
            # This point belongs only to the fixture, outside the KB purge scope.
            response = storage.post(
                f"{path}/delete", params={"wait": "true"}, json={"points": [10004]}
            )
            response.raise_for_status()
