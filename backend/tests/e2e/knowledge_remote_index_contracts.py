# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real API coverage for sharing, transfer and personal-key MCP access."""

from __future__ import annotations

import json
import secrets
import uuid
from contextlib import ExitStack
from typing import Any

import httpx
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    _auth_headers,
    _check,
    _chunk_contents,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_knowledge_base,
    _document_chunks,
    _document_row,
    _internal_retrieve,
    _load_document_row,
    _log,
    _public_list_chunks,
    _upload_attachment,
    _wait_for_index_status,
)


def _success(response: httpx.Response, action: str) -> dict[str, Any]:
    _check(response.is_success, f"{action} failed: {response.status_code}")
    return response.json() if response.content else {}


def _cleanup(client: httpx.Client, token: str, path: str) -> None:
    response = client.delete(path, headers=_auth_headers(token))
    _check(
        response.is_success, f"fixture cleanup failed: {path} {response.status_code}"
    )


def _reader(
    client: httpx.Client, owner_token: str, cleanup: ExitStack
) -> tuple[str, int]:
    name = f"e2e-contract-reader-{uuid.uuid4().hex[:12]}"
    password = secrets.token_urlsafe(24)
    user = _success(
        client.post(
            "/api/users",
            headers=_auth_headers(owner_token),
            json={"user_name": name, "password": password},
        ),
        "create reader",
    )
    user_id = int(user["id"])
    cleanup.callback(_cleanup, client, owner_token, f"/api/admin/users/{user_id}")
    login = _success(
        client.post("/api/auth/login", json={"user_name": name, "password": password}),
        "reader login",
    )
    return login["access_token"], user_id


def _assert_denied(response: httpx.Response, action: str) -> None:
    _check(
        response.status_code in (403, 404)
        or (response.status_code == 400 and "do not have permission" in response.text),
        f"{action} allowed or failed without permission denial: {response.status_code}",
    )


def _assert_index_contents(
    client: httpx.Client, token: str, kb_id: int, marker: str, expected: bool
) -> None:
    chunks = _success(_public_list_chunks(client, token, kb_id), "list KB index")
    contents = _chunk_contents(chunks.get("items", []))
    _check((marker in contents) is expected, f"KB {kb_id} index marker mismatch")
    _check(int(chunks["total"]) == int(expected), f"KB {kb_id} index count mismatch")


def _run_sharing(
    client: httpx.Client,
    owner: str,
    reader: str,
    reader_id: int,
    kb_id: int,
    doc_id: int,
    marker: str,
) -> None:
    members = f"/api/share/KnowledgeBase/{kb_id}/members"
    doc = f"/api/knowledge-documents/{doc_id}"
    member = _success(
        client.post(
            members,
            headers=_auth_headers(owner),
            json={"user_id": reader_id, "role": "Reporter"},
        ),
        "share read-only",
    )
    member_path = f"{members}/{member['id']}"
    _check(
        marker
        in _success(
            client.get(f"{doc}/detail", headers=_auth_headers(reader)), "reader preview"
        ).get("content", ""),
        "reader cannot see source content",
    )
    search = _success(
        _internal_retrieve(client, kb_id, doc_id, marker, user_id=reader_id),
        "shared reader retrieval",
    )
    _check(
        any(
            marker in record.get("content", "") for record in search.get("records", [])
        ),
        "shared reader retrieval missed content",
    )
    for method, suffix, body in (
        ("PUT", "/content", {"content": "unauthorized mutation"}),
        ("POST", "/reindex", None),
        ("DELETE", "", None),
    ):
        _assert_denied(
            client.request(
                method, f"{doc}{suffix}", headers=_auth_headers(reader), json=body
            ),
            f"read-only {method} {suffix}",
        )
    _check(
        marker in _chunk_contents(_document_chunks(client, owner, doc_id)),
        "denied actions changed the source index",
    )
    _success(
        client.put(
            member_path, headers=_auth_headers(owner), json={"role": "Maintainer"}
        ),
        "grant edit",
    )
    edited = f"{marker}-edited"
    _success(
        client.put(
            f"{doc}/content", headers=_auth_headers(reader), json={"content": edited}
        ),
        "shared editor update",
    )
    _wait_for_index_status(client, owner, kb_id, doc_id, "success")
    _check(
        edited in _chunk_contents(_document_chunks(client, owner, doc_id)),
        "shared edit did not reach the real index",
    )
    _success(client.delete(member_path, headers=_auth_headers(owner)), "revoke share")
    for method, suffix, body in (
        ("GET", "/detail", None),
        ("PUT", "/content", {"content": "revoked"}),
        ("POST", "/reindex", None),
        ("DELETE", "", None),
    ):
        _assert_denied(
            client.request(
                method, f"{doc}{suffix}", headers=_auth_headers(reader), json=body
            ),
            f"revoked {method} {suffix}",
        )
    refused_query = _internal_retrieve(client, kb_id, doc_id, edited, user_id=reader_id)
    _check(
        refused_query.status_code in (403, 404)
        or (refused_query.is_success and not refused_query.json().get("records")),
        "revoked reader still retrieves source content",
    )
    _log("sharing: real read-only denial, editor indexing and revoked access passed")


def _rpc(
    client: httpx.Client, key: str, method: str, params: dict[str, Any]
) -> dict[str, Any]:
    response = client.post(
        "/mcp/knowledge-external/sse",
        headers={**_auth_headers(key), "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
    )
    body = _success(response, f"MCP {method}")
    _check("error" not in body, f"MCP {method} returned a protocol error")
    _check(
        body.get("jsonrpc") == "2.0" and body.get("id") == 1,
        f"MCP {method} returned an invalid JSON-RPC envelope",
    )
    return body["result"]


def _tool(
    client: httpx.Client, key: str, name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    result = _rpc(client, key, "tools/call", {"name": name, "arguments": arguments})
    _check(not result.get("isError"), f"MCP {name} returned a tool error")
    blocks = result.get("content", [])
    _check(
        len(blocks) == 1 and blocks[0].get("type") == "text",
        f"MCP {name} must return one JSON text block",
    )
    text = blocks[0]["text"]
    payload = json.loads(text)
    _check(isinstance(payload, dict), f"MCP {name} returned double-encoded JSON")
    structured = result.get("structuredContent")
    if arguments.get("response_format") == "structured":
        _check(
            structured == payload, f"MCP {name} structured payload differs from text"
        )
    else:
        _check(
            structured == {"result": text},
            f"MCP {name} changed the default legacy result envelope",
        )
    return payload


def _mcp_search_document(
    client: httpx.Client,
    token: str,
    kb_id: int,
    cleanup: ExitStack,
    query: str,
    ranks: tuple[int, ...],
    marker: str,
) -> int:
    # Separate Markdown sections create real chunks without overlap or merging.
    content = "\n\n".join(
        f"# Match {rank}\n\n{query} WEGENT-MCP-RANK-{rank} {marker}" for rank in ranks
    )
    attachment = _success(
        client.post(
            "/api/attachments/upload",
            headers=_auth_headers(token),
            files={"file": ("mcp-matches.md", content.encode(), "text/markdown")},
        ),
        "upload MCP matching sections",
    )
    document = _success(
        client.post(
            f"/api/knowledge-bases/{kb_id}/documents",
            headers=_auth_headers(token),
            json={
                "attachment_id": int(attachment["id"]),
                "name": "mcp-matches.md",
                "file_extension": "md",
                "splitter_config": {
                    "chunk_strategy": "flat",
                    "format_enhancement": "file_aware",
                    "flat_config": {"chunk_size": 256, "chunk_overlap": 0},
                    "markdown_enhancement": {"enabled": False},
                },
            },
        ),
        "create MCP matching document",
    )
    doc_id = int(document["id"])
    cleanup.callback(_cleanup, client, token, f"/api/knowledge-documents/{doc_id}")
    _wait_for_index_status(client, token, kb_id, doc_id, "success")
    chunks = _document_chunks(client, token, doc_id)
    _check(len(chunks) == len(ranks), f"MCP document {doc_id} chunk count mismatch")
    for rank in ranks:
        _check(
            sum(
                query in chunk["content"]
                and f"WEGENT-MCP-RANK-{rank}" in chunk["content"]
                and marker in chunk["content"]
                for chunk in chunks
            )
            == 1,
            f"MCP document {doc_id} lacks one distinct matching chunk for rank {rank}",
        )
    return doc_id


def _mcp_search_base(client: httpx.Client, token: str, cleanup: ExitStack) -> int:
    name = f"e2e-mcp-diversity-{uuid.uuid4().hex[:12]}"
    _create_retrieval_resources(
        client,
        token,
        name,
        embedding_url=EMBEDDING_MODEL_URL,
        embedding_model_id=name,
        on_created=lambda path: cleanup.callback(_cleanup, client, token, path),
    )
    kb_id = int(_create_knowledge_base(client, token, name, name)["id"])
    cleanup.callback(_delete_knowledge_base, client, token, kb_id)
    _success(
        client.put(
            f"/api/knowledge-bases/{kb_id}",
            headers=_auth_headers(token),
            json={"retrieval_config": {"top_k": 10}},
        ),
        "set MCP candidate window",
    )
    return kb_id


def _assert_mcp_search_counts(
    payload: dict[str, Any],
    *,
    total: int,
    returned: int,
    documents: int,
    deduplicate: bool,
) -> None:
    records = payload.get("records", [])
    document_ids = {
        (record["knowledge_base_id"], record["document_id"]) for record in records
    }
    _check(
        payload.get("total") == total
        and payload.get("total_returned") == returned == len(records),
        "MCP candidate/returned record counts mismatch",
    )
    _check(
        payload.get("returned_document_count") == documents == len(document_ids),
        "MCP returned document count mismatch",
    )
    _check(
        payload.get("deduplicate_by_document") is deduplicate,
        "MCP document mode was not preserved",
    )
    scores = [record["score"] for record in records]
    _check(
        all(isinstance(score, (int, float)) for score in scores)
        and scores == sorted(scores, reverse=True),
        "MCP real hits are not ranked by score",
    )


def _assert_mcp_diversity(
    client: httpx.Client,
    key: str,
    arguments: dict[str, Any],
    doc_ids: list[int],
) -> dict[str, Any]:
    raw = _tool(client, key, "wegent_kb_search_content", arguments)
    _assert_mcp_search_counts(raw, total=6, returned=6, documents=2, deduplicate=False)
    _check(
        raw.get("searched_knowledge_base_ids") == arguments["knowledge_base_ids"]
        and raw.get("ignored_knowledge_base_ids") == []
        and raw.get("warnings") == [],
        "MCP accessible-only search scope mismatch",
    )
    best = []
    for doc_id, rank in zip(doc_ids, (1, 4)):
        hits = [record for record in raw["records"] if record["document_id"] == doc_id]
        _check(len(hits) == 3, f"MCP document {doc_id} must have three real hits")
        _check(
            hits[0]["score"] > hits[1]["score"] > hits[2]["score"]
            and f"WEGENT-MCP-RANK-{rank}" in hits[0]["content"],
            f"MCP document {doc_id} highest-scoring chunk mismatch",
        )
        best.append(hits[0])
    limited = _tool(
        client, key, "wegent_kb_search_content", {**arguments, "max_results": 2}
    )
    _assert_mcp_search_counts(
        limited, total=6, returned=2, documents=1, deduplicate=False
    )
    _check(limited["records"] == raw["records"][:2], "MCP chunk limit changed ranking")
    document_arguments = {**arguments, "deduplicate_by_document": True}
    for limit in (5, 2, 1):
        distinct = _tool(
            client,
            key,
            "wegent_kb_search_content",
            {**document_arguments, "max_results": limit},
        )
        count = min(limit, len(doc_ids))
        _assert_mcp_search_counts(
            distinct, total=6, returned=count, documents=count, deduplicate=True
        )
        _check(
            distinct["records"] == best[:limit],
            "MCP must retain each document's highest score before applying max_results",
        )
    return raw


def _assert_mcp_scope_rejected(
    client: httpx.Client, key: str, arguments: dict[str, Any], private_kb: int
) -> None:
    for deduplicate in (False, True):
        refused = _tool(
            client,
            key,
            "wegent_kb_search_content",
            {
                **arguments,
                "knowledge_base_ids": [private_kb],
                "deduplicate_by_document": deduplicate,
            },
        )
        _check(
            refused
            == {"code": "not_found", "error": "No accessible knowledge bases found"},
            "MCP unauthorized-only scope must reject an existing private KB without data",
        )


def _assert_mcp_private_scope(
    client: httpx.Client,
    key: str,
    arguments: dict[str, Any],
    baseline: dict[str, Any],
    private_kb: int,
    private_doc: int,
    private_marker: str,
) -> None:
    _assert_mcp_scope_rejected(client, key, arguments, private_kb)
    for deduplicate, limit in ((False, 10), (True, 2)):
        mixed = _tool(
            client,
            key,
            "wegent_kb_search_content",
            {
                **arguments,
                "knowledge_base_ids": [private_kb, *arguments["knowledge_base_ids"]],
                "deduplicate_by_document": deduplicate,
                "max_results": limit,
            },
        )
        count = 2 if deduplicate else 6
        _assert_mcp_search_counts(
            mixed, total=6, returned=count, documents=2, deduplicate=deduplicate
        )
        highest_hits: dict[int, dict[str, Any]] = {}
        for record in baseline["records"]:
            highest_hits.setdefault(record["document_id"], record)
        expected = list(highest_hits.values()) if deduplicate else baseline["records"]
        _check(mixed["records"] == expected, "MCP mixed scope changed accessible hits")
        _check(
            mixed.get("searched_knowledge_base_ids") == arguments["knowledge_base_ids"]
            and mixed.get("ignored_knowledge_base_ids") == [private_kb]
            and mixed.get("warnings"),
            "MCP mixed scope did not report the inaccessible KB as ignored",
        )
        _check(
            all(
                record["knowledge_base_id"] != private_kb
                and record["document_id"] != private_doc
                and private_marker not in record["content"]
                for record in mixed["records"]
            ),
            "MCP mixed scope leaked private records",
        )


def _run_mcp_search_contracts(
    client: httpx.Client, key: str, owner: str, reader: str, reader_id: int
) -> None:
    query = f"MCP-MATCH-{uuid.uuid4().hex[:12]}"
    private_marker = f"PRIVATE-{uuid.uuid4().hex[:12]}"
    with ExitStack() as cleanup:
        accessible_kb = _mcp_search_base(client, owner, cleanup)
        doc_ids = [
            _mcp_search_document(
                client, owner, accessible_kb, cleanup, query, ranks, "public-match"
            )
            for ranks in ((3, 2, 1), (6, 5, 4))
        ]
        private_kb = _mcp_search_base(client, reader, cleanup)
        private_doc = _mcp_search_document(
            client, reader, private_kb, cleanup, query, (7, 0), private_marker
        )
        _assert_denied(
            client.get(
                f"/api/knowledge-documents/{private_doc}/detail",
                headers=_auth_headers(owner),
            ),
            "owner access to the other user's private fixture",
        )
        # Prove the excluded document actually matches in the real index.
        private_hits = _success(
            _internal_retrieve(
                client, private_kb, private_doc, query, user_id=reader_id
            ),
            "private owner retrieval",
        ).get("records", [])
        _check(
            len(private_hits) == 2
            and all(private_marker in record["content"] for record in private_hits),
            "private fixture must have two real matching chunks",
        )
        for response_format in (None, "structured"):
            arguments: dict[str, Any] = {
                "query": query,
                "knowledge_base_ids": [accessible_kb],
                "max_results": 10,
            }
            if response_format is not None:
                arguments["response_format"] = response_format
            baseline = _assert_mcp_diversity(client, key, arguments, doc_ids)
            _assert_mcp_private_scope(
                client,
                key,
                arguments,
                baseline,
                private_kb,
                private_doc,
                private_marker,
            )
    _log("MCP: real multi-chunk diversity, counts, envelopes and private scopes passed")


def _run_mcp(
    client: httpx.Client,
    token: str,
    kb_id: int,
    other_kb_id: int,
    doc_id: int,
    marker: str,
    reader: str,
    reader_id: int,
) -> None:
    created = _success(
        client.post(
            "/api/api-keys",
            headers=_auth_headers(token),
            json={"name": "e2e-contract-mcp"},
        ),
        "create personal key",
    )
    key_id, key = int(created["id"]), created["key"]
    try:
        initialized = _rpc(
            client,
            key,
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "knowledge-contract-e2e", "version": "1.0"},
            },
        )
        _check(initialized.get("serverInfo"), "MCP initialize lacks server metadata")
        tools = _rpc(client, key, "tools/list", {})
        _check(
            "wegent_kb_search_content" in [tool["name"] for tool in tools["tools"]],
            "MCP search tool is missing",
        )
        content = _tool(
            client, key, "wegent_kb_get_document_content", {"document_id": doc_id}
        )
        _check(marker in content.get("content", ""), "MCP source content mismatch")
        found = _tool(
            client,
            key,
            "wegent_kb_search_content",
            {
                "query": marker,
                "knowledge_base_ids": [kb_id],
                "max_results": 5,
            },
        )
        _check(
            any(
                int(record.get("document_id", 0)) == doc_id
                and marker in record["content"]
                for record in found.get("records", [])
            ),
            "MCP real retrieval missed document",
        )
        multi = _tool(
            client,
            key,
            "wegent_kb_search_content",
            {
                "query": marker,
                "knowledge_base_ids": [other_kb_id, kb_id],
                "max_results": 5,
            },
        )
        _check(
            set(multi.get("searched_knowledge_base_ids", [])) == {kb_id, other_kb_id},
            "MCP multi-KB search did not preserve explicit scope",
        )
        _check(
            multi.get("records")
            and all(
                int(record["knowledge_base_id"]) == kb_id
                and int(record["document_id"]) == doc_id
                for record in multi["records"]
            ),
            "MCP multi-KB search leaked another document",
        )
        for scope, code, message in (
            ([], "bad_request", "knowledge_base_ids must not be empty"),
            ([0], "not_found", "No accessible knowledge bases found"),
        ):
            refused = _tool(
                client,
                key,
                "wegent_kb_search_content",
                {
                    "query": marker,
                    "knowledge_base_ids": scope,
                    "max_results": 5,
                },
            )
            _check(
                refused.get("code") == code and refused.get("error") == message,
                "MCP invalid scope did not return its specific error",
            )
            _check("records" not in refused, "MCP invalid scope returned document data")
        _run_mcp_search_contracts(client, key, token, reader, reader_id)
    finally:
        _cleanup(client, token, f"/api/api-keys/{key_id}")
    revoked = client.post(
        "/mcp/knowledge-external/sse",
        headers={
            **_auth_headers(key),
            "Accept": "application/json, text/event-stream",
        },
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    _check(revoked.status_code == 401, "revoked personal key still authenticates")
    _log(
        "personal-key MCP: initialize, tools, read, real retrieval and revoke 401 passed"
    )


def _run_transfer(
    client: httpx.Client,
    token: str,
    source: int,
    target: int,
    doc_id: int,
    marker: str,
    group: str,
) -> None:
    before = _load_document_row(doc_id)
    migrated = _success(
        client.post(
            f"/api/knowledge-bases/{source}/migrate",
            headers=_auth_headers(token),
            json={"target_group_name": group},
        ),
        "migrate personal KB",
    )
    _check(migrated.get("new_namespace") == group, "migration namespace mismatch")
    _check(
        _load_document_row(doc_id)["attachment_id"] == before["attachment_id"],
        "migration replaced the attachment",
    )
    _assert_index_contents(client, token, source, marker, True)
    transferred = _success(
        client.post(
            f"/api/knowledge-bases/{source}/transfer-documents",
            headers=_auth_headers(token),
            json={"target_kb_id": target, "document_ids": [doc_id]},
        ),
        "transfer document",
    )
    _check(
        transferred.get("transferred_document_count") == 1, "transfer count mismatch"
    )
    listing = _success(
        client.get(
            f"/api/knowledge-bases/{source}/documents", headers=_auth_headers(token)
        ),
        "source document list",
    )
    _check(
        not any(int(item["id"]) == doc_id for item in listing.get("items", [])),
        "transferred document remains in source",
    )
    _document_row(client, token, target, doc_id)
    _check(
        _load_document_row(doc_id)["attachment_id"] == before["attachment_id"],
        "transfer replaced the attachment",
    )
    _assert_index_contents(client, token, source, marker, False)
    _wait_for_index_status(client, token, target, doc_id, "success")
    _assert_index_contents(client, token, target, marker, True)
    _assert_index_contents(client, token, source, marker, False)
    _log(
        "migration/transfer: stable identity, source cleanup and automatic target indexing passed"
    )


def run_contract_scenarios(
    client: httpx.Client, token: str, owner_user_id: int
) -> None:
    """Exercise API contracts using disposable resources in the real CI stack."""
    del owner_user_id
    name = f"e2e-contract-{uuid.uuid4().hex[:12]}"
    with ExitStack() as cleanup:
        reader, reader_id = _reader(client, token, cleanup)
        _create_retrieval_resources(
            client,
            token,
            name,
            embedding_url=EMBEDDING_MODEL_URL,
            on_created=lambda path: cleanup.callback(_cleanup, client, token, path),
        )
        group = f"e2e-contract-group-{uuid.uuid4().hex[:12]}"
        _success(
            client.post(
                "/api/groups", headers=_auth_headers(token), json={"name": group}
            ),
            "create group",
        )
        cleanup.callback(_cleanup, client, token, f"/api/groups/{group}")
        source = int(_create_knowledge_base(client, token, name, name)["id"])
        cleanup.callback(_delete_knowledge_base, client, token, source)
        target = int(
            _create_knowledge_base(client, token, f"{name}-target", name)["id"]
        )
        cleanup.callback(_delete_knowledge_base, client, token, target)
        marker = f"CONTRACT-{uuid.uuid4().hex}"
        attachment, _ = _upload_attachment(client, token, marker)
        document = _create_document(client, token, source, attachment)
        doc_id = int(document["id"])
        cleanup.callback(_cleanup, client, token, f"/api/knowledge-documents/{doc_id}")
        _wait_for_index_status(client, token, source, doc_id, "success")
        _run_sharing(client, token, reader, reader_id, source, doc_id, marker)
        _run_transfer(client, token, source, target, doc_id, f"{marker}-edited", group)
        _run_mcp(
            client, token, target, source, doc_id, f"{marker}-edited", reader, reader_id
        )
