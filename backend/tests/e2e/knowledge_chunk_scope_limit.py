# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Live chunks remain visible behind more than one raw scan window of remnants."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from functools import partial
from typing import Any

import httpx
from knowledge_confirmed_deletion import _continue
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
    _log,
    _point_retriever_at,
    _public_list_chunks,
    _upload_attachment,
    _wait_for_index_status,
)

RESIDUAL_COUNT = 10001


@dataclass
class ChunkScopeFixture:
    name: str
    collection: str
    knowledge_bases: list[int] = field(default_factory=list)
    documents: list[tuple[int, int]] = field(default_factory=list)


@contextmanager
def _fixture(client: httpx.Client, token: str) -> Iterator[ChunkScopeFixture]:
    fixture = ChunkScopeFixture(
        name=f"e2e-chunk-scope-{uuid.uuid4().hex[:10]}",
        collection=f"chunk_scope_{uuid.uuid4().hex}",
    )
    _create_retrieval_resources(
        client, token, fixture.name, embedding_url=EMBEDDING_MODEL_URL
    )
    try:
        _point_retriever_at(
            client,
            token,
            fixture.name,
            QDRANT_URL,
            index_strategy={"mode": "fixed", "fixedName": fixture.collection},
        )
        for suffix in ("target", "peer"):
            kb = _create_knowledge_base(
                client, token, f"{fixture.name}-{suffix}", fixture.name
            )
            fixture.knowledge_bases.append(int(kb["id"]))
        target, peer = fixture.knowledge_bases
        for kb_id, marker in (
            (target, "SCOPE-DELETED"),
            (target, "SCOPE-LIVE"),
            (peer, "SCOPE-PEER"),
        ):
            attachment, _ = _upload_attachment(client, token, marker)
            document_id = int(_create_document(client, token, kb_id, attachment)["id"])
            fixture.documents.append((kb_id, document_id))
            _wait_for_index_status(client, token, kb_id, document_id, "success")
        yield fixture
    finally:
        _cleanup_fixture(client, token, fixture)


def _cleanup_fixture(
    client: httpx.Client, token: str, fixture: ChunkScopeFixture
) -> None:
    _point_retriever_at(
        client,
        token,
        fixture.name,
        QDRANT_URL,
        index_strategy={"mode": "fixed", "fixedName": fixture.collection},
    )
    for _, document_id in fixture.documents:
        if _document_row_exists(document_id):
            response = client.delete(
                f"/api/knowledge-documents/{document_id}", headers=_auth_headers(token)
            )
            _check(
                response.status_code < 300,
                f"fixture document cleanup failed: {response.text}",
            )
    for kb_id in fixture.knowledge_bases:
        response = client.delete(
            f"/api/knowledge-bases/{kb_id}", headers=_auth_headers(token)
        )
        _check(
            response.status_code < 300, f"fixture KB cleanup failed: {response.text}"
        )
    with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
        for collection in (fixture.collection, f"{fixture.collection}__parents"):
            response = storage.delete(f"/collections/{collection}")
            _check(
                response.status_code < 300 or response.status_code == 404,
                "fixture collection cleanup failed",
            )
    _delete_retrieval_resources(client, token, fixture.name)


def _knowledge_filter(knowledge_id: int) -> dict[str, Any]:
    return {"must": [{"key": "knowledge_id", "match": {"value": str(knowledge_id)}}]}


def _point_snapshot(
    storage: httpx.Client, fixture: ChunkScopeFixture, document_id: int
) -> dict[str, Any]:
    response = storage.post(
        f"/collections/{fixture.collection}/points/scroll",
        json={
            "filter": {
                "must": [{"key": "doc_ref", "match": {"value": str(document_id)}}]
            },
            "limit": 1,
            "with_payload": True,
            "with_vector": True,
        },
    )
    response.raise_for_status()
    points = response.json()["result"]["points"]
    _check(points, "the indexed document must have real external points")
    return points[0]


def _write_window(
    storage: httpx.Client, fixture: ChunkScopeFixture, deleted: dict, live: dict
) -> None:
    target = fixture.knowledge_bases[0]
    response = storage.post(
        f"/collections/{fixture.collection}/points/delete",
        params={"wait": "true"},
        json={"filter": _knowledge_filter(target)},
    )
    response.raise_for_status()
    for start in range(1, RESIDUAL_COUNT + 1, 500):
        points = [
            {"id": point_id, "vector": deleted["vector"], "payload": deleted["payload"]}
            for point_id in range(start, min(start + 500, RESIDUAL_COUNT + 1))
        ]
        _upsert_points(storage, fixture.collection, points)
    live_id = fixture.documents[1][1]
    _upsert_points(
        storage,
        fixture.collection,
        [
            {
                "id": RESIDUAL_COUNT + 1 + index,
                "vector": live["vector"],
                "payload": {
                    **live["payload"],
                    "doc_ref": reference,
                    "chunk_index": index,
                },
            }
            for index, reference in enumerate((str(live_id), f"doc_{live_id}"))
        ],
    )
    _assert_raw_window(storage, fixture)


def _upsert_points(storage: httpx.Client, collection: str, points: list[dict]) -> None:
    response = storage.put(
        f"/collections/{collection}/points",
        params={"wait": "true"},
        json={"points": points},
    )
    response.raise_for_status()


def _assert_raw_window(storage: httpx.Client, fixture: ChunkScopeFixture) -> None:
    raw = storage.post(
        f"/collections/{fixture.collection}/points/scroll",
        json={
            "filter": _knowledge_filter(fixture.knowledge_bases[0]),
            "limit": 10000,
            "with_payload": True,
            "with_vector": False,
        },
    )
    raw.raise_for_status()
    window = raw.json()["result"]
    _check(
        len(window["points"]) == 10000 and window["next_page_offset"] is not None,
        "the raw window must truncate before live chunks",
    )
    _check(
        all(
            point["payload"]["doc_ref"] == str(fixture.documents[0][1])
            for point in window["points"]
        ),
        "the raw candidate window must contain remnants only",
    )


def _assert_live_pages(
    client: httpx.Client, token: str, fixture: ChunkScopeFixture
) -> None:
    target = fixture.knowledge_bases[0]
    live_id = fixture.documents[1][1]
    seen = []
    for page in (1, 2, 3):
        response = _public_list_chunks(client, token, target, page=page, page_size=1)
        _check(
            response.status_code == 200,
            f"listing scoped chunks failed: {response.text}",
        )
        body = response.json()
        _check(body["total"] == 2, f"the count must exclude all remnants: {body}")
        _check(
            len(body["items"]) == (1 if page < 3 else 0),
            "pages must only contain live chunks",
        )
        seen.extend(body["items"])
    _check(
        {item["doc_ref"] for item in seen} == {str(live_id), f"doc_{live_id}"},
        "both live reference encodings must survive the native limit",
    )
    _check(
        all(item["metadata"]["knowledge_id"] == str(target) for item in seen),
        "shared collection knowledge scope must be preserved",
    )


def _assert_peer_unchanged(
    client: httpx.Client,
    token: str,
    fixture: ChunkScopeFixture,
    owner_user_id: int,
    peer_before: dict[str, Any],
) -> None:
    peer = fixture.knowledge_bases[1]
    peer_after = _public_list_chunks(client, token, peer)
    _check(
        peer_after.status_code == 200 and peer_after.json() == peer_before,
        "the shared collection peer must remain unchanged",
    )
    query = _internal_retrieve_knowledge_base(
        client, peer, "SCOPE-PEER", user_id=owner_user_id
    )
    _check(query.status_code == 200, f"peer retrieval failed: {query.text}")
    _assert_records_reference_document(
        query.json()["records"], peer, fixture.documents[2][1], "SCOPE-PEER"
    )


def run_chunk_scope_limit(client: httpx.Client, token: str, owner_user_id: int) -> None:
    with _fixture(client, token) as fixture:
        peer = fixture.knowledge_bases[1]
        deleted_id = fixture.documents[0][1]
        point = partial(
            _point_retriever_at,
            client,
            token,
            fixture.name,
            index_strategy={"mode": "fixed", "fixedName": fixture.collection},
        )
        peer_before = _public_list_chunks(client, token, peer)
        _check(
            peer_before.status_code == 200 and peer_before.json()["items"],
            "the peer must start with visible chunks",
        )
        with httpx.Client(base_url=QDRANT_URL, timeout=30) as storage:
            deleted = _point_snapshot(storage, fixture, deleted_id)
            live = _point_snapshot(storage, fixture, fixture.documents[1][1])
            disabled = client.put(
                f"/api/knowledge-documents/{fixture.documents[1][1]}",
                headers=_auth_headers(token),
                json={"status": "disabled"},
            )
            _check(
                disabled.status_code == 200 and disabled.json()["status"] == "disabled",
                "the live fixture must be disabled but remain viewable",
            )
            point(UNREACHABLE_QDRANT_URL)
            _continue(client, token, f"/api/knowledge-documents/{deleted_id}")
            _check(
                not _document_row_exists(deleted_id),
                "confirmed deletion must remove the document",
            )
            point(QDRANT_URL)
            _write_window(storage, fixture, deleted, live)
        _assert_live_pages(client, token, fixture)
        _assert_peer_unchanged(
            client, token, fixture, owner_user_id, peer_before.json()
        )
        _log(
            "10001 real remnants precede live chunks; scoped pages, count and shared peer passed"
        )
