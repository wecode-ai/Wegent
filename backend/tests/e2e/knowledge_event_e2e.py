# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Knowledge event checks using the CI's real Backend, worker and Runtime.

Conversion assertions exercise the existing MinerU-simulated protocol scenario;
they are protocol integration coverage, not real MinerU compatibility testing.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from knowledge_remote_index_public import (
    _delete_unattached_content,
    _point_embedding_at,
)
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    INTERNAL_SERVICE_TOKEN,
    UNREACHABLE_EMBEDDING_URL,
    _auth_headers,
    _check,
    _create_client,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_document,
    _delete_knowledge_base,
    _delete_retrieval_resources,
    _delete_scenario_fixtures,
    _document_chunks,
    _internal_retrieve,
    _login,
    _upload_attachment,
    _wait_for_index_status,
)

PROBE = Path(os.environ["WEGENT_E2E_EVENT_PROBE_DIR"])
EVENTS = PROBE / "events.jsonl"
PYTHON_LOG = Path(os.environ["E2E_PYTHON_LOG"])


def _events(offset: int = 0) -> list[dict[str, Any]]:
    with EVENTS.open("rb") as stream:
        stream.seek(offset)
        data = stream.read()
    # A writer may be appending while the reader takes its snapshot.
    return [
        json.loads(line)
        for line in data.splitlines(keepends=True)
        if line.endswith(b"\n")
    ]


def _wait_for_event(offset: int, event_type: str, predicate: Any) -> dict[str, Any]:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        for row in _events(offset):
            event = row["event"]
            if event["event_type"] == event_type and predicate(event):
                return row
        time.sleep(0.1)
    raise AssertionError(f"missing event: {event_type}")


def _assert_conversion_protocol_events() -> None:
    """Check the existing conversion scenarios; MinerU itself is simulated."""
    rows = _events()
    matched_documents = set()
    for outcome in ("success", "failure"):
        finished = [
            row
            for row in rows
            if row["event"]["event_type"] == "knowledge.conversion.attempt.finished"
            and row["event"]["status"] == outcome
            and row["event"]["document_id"] is not None
        ]
        _check(bool(finished), f"missing simulated-MinerU conversion {outcome} event")
        paired = [
            row
            for row in finished
            if any(
                started["event"]["event_type"] == "knowledge.conversion.attempt.started"
                and started["event"]["fact_key_parts"] == row["event"]["fact_key_parts"]
                and started["pid"] == row["pid"]
                for started in rows
            )
        ]
        _check(bool(paired), f"missing conversion start for {outcome}")
        matched_documents.add(paired[0]["event"]["document_id"])
    _check(
        len(matched_documents) == 2, "conversion outcomes must use different documents"
    )
    print(
        "PASS: conversion protocol integration (MinerU simulated; real compatibility unverified)"
    )


def _upload_long_document(client: httpx.Client, token: str, marker: str) -> int:
    text = "\n\n".join(f"{marker} paragraph {i}: " + "word " * 220 for i in range(8))
    response = client.post(
        "/api/attachments/upload",
        headers=_auth_headers(token),
        files={"file": ("events.md", text.encode(), "text/markdown")},
    )
    _check(response.status_code == 200, f"attachment upload failed: {response.text}")
    return int(response.json()["id"])


def _assert_transaction_failure(
    client: httpx.Client, token: str, kb_id: int, user_id: int
) -> None:
    from app.db.session import engine

    attachment_id, _ = _upload_attachment(client, token, "WEGENT-EVENT-ROLLBACK")
    trigger = "e2e_event_" + uuid.uuid4().hex[:12]
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(
                f"CREATE TRIGGER {trigger} BEFORE INSERT ON knowledge_documents "
                f"FOR EACH ROW BEGIN IF NEW.kind_id = {int(kb_id)} THEN "
                "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'e2e transaction failure'; "
                "END IF; END"
            )
        offset = EVENTS.stat().st_size
        log_offset = PYTHON_LOG.stat().st_size
        try:
            response = client.post(
                f"/api/knowledge-bases/{kb_id}/documents",
                headers=_auth_headers(token),
                json={
                    "attachment_id": attachment_id,
                    "name": "transaction-failure.md",
                    "file_extension": "md",
                    "folder_id": 0,
                    "source_type": "file",
                },
            )
            _check(
                response.status_code >= 400,
                f"transaction unexpectedly succeeded: {response.text}",
            )
        finally:
            with engine.begin() as connection:
                connection.exec_driver_sql(f"DROP TRIGGER {trigger}")
        with engine.connect() as connection:
            count = connection.exec_driver_sql(
                "SELECT COUNT(*) FROM knowledge_documents WHERE kind_id = %s AND name = %s",
                (kb_id, "transaction-failure.md"),
            ).scalar_one()
        _check(count == 0, "failed transaction left a document row")
        with PYTHON_LOG.open("rb") as stream:
            stream.seek(log_offset)
            _check(
                b"e2e transaction failure" in stream.read(),
                "the database trigger was not reached",
            )
        created = [
            row
            for row in _events(offset)
            if row["event"]["event_type"] == "knowledge.document.created"
            and str(row["event"]["kb_id"]) == str(kb_id)
        ]
        _check(
            not created,
            f"failed transaction emitted a successful document event: {created}",
        )
    finally:
        _delete_unattached_content(attachment_id, user_id)


def _assert_retrieval_events(
    client: httpx.Client,
    kb_id: int,
    document_id: int,
    user_id: int,
    query: str,
    index_worker_pid: int,
) -> None:
    offset = EVENTS.stat().st_size
    response = _internal_retrieve(client, kb_id, document_id, query, user_id=user_id)
    _check(response.status_code == 200, f"retrieval failed: {response.text}")
    records = response.json()["records"]
    matches = [record for record in records if record.get("document_id") == document_id]
    _check(
        len(matches) >= 2,
        f"fixture must return multiple chunks of one document: {records}",
    )
    request_row = _wait_for_event(
        offset,
        "knowledge.retrieval.request.finished",
        lambda event: event["status"] == "success"
        and event["data"].get("actor_user_id") == user_id,
    )
    _check(
        request_row["pid"] != index_worker_pid,
        "retrieval and index must use separate processes",
    )
    request = request_row["event"]
    invocation = request["data"]["invocation_id"]
    usage = [
        row["event"]
        for row in _events(offset)
        if row["event"]["event_type"] == "knowledge.usage.document.recorded"
        and row["event"]["data"].get("invocation_id") == invocation
    ]
    _check(len(usage) == 1, f"document use must be deduplicated: {usage}")
    _check(
        usage[0]["document_id"] == document_id, f"wrong document attribution: {usage}"
    )
    _check(
        usage[0]["data"]["actor_user_id"] == user_id, f"wrong user attribution: {usage}"
    )
    _wait_for_event(
        offset,
        "knowledge.retrieval.execution.finished",
        lambda event: event["status"] == "success"
        and event["data"].get("invocation_id") == invocation,
    )

    fault = PROBE / "fail-receiver"
    offset = EVENTS.stat().st_size
    fault.touch()
    try:
        response = _internal_retrieve(
            client, kb_id, document_id, query, user_id=user_id
        )
        _check(
            response.status_code == 200 and response.json()["records"],
            f"receiver exception changed retrieval: {response.status_code} {response.text}",
        )
        _check(
            any(
                row["injected_failure"]
                and row["pid"] == request_row["pid"]
                and row["event"]["event_type"] == "knowledge.retrieval.request.finished"
                and row["event"]["data"].get("actor_user_id") == user_id
                for row in _events(offset)
            ),
            "the Backend retrieval receiver did not raise",
        )
    finally:
        fault.unlink(missing_ok=True)


def _assert_failed_events(
    client: httpx.Client,
    token: str,
    name: str,
    kb_id: int,
    document_id: int,
    user_id: int,
    query: str,
) -> None:
    _point_embedding_at(client, token, name, UNREACHABLE_EMBEDDING_URL)
    offset = EVENTS.stat().st_size
    response = _internal_retrieve(client, kb_id, document_id, query, user_id=user_id)
    _check(
        response.status_code >= 500, f"failed retrieval must surface: {response.text}"
    )
    request = _wait_for_event(
        offset,
        "knowledge.retrieval.request.finished",
        lambda event: event["status"] == "failure"
        and event["data"].get("actor_user_id") == user_id,
    )["event"]
    invocation = request["data"]["invocation_id"]
    _wait_for_event(
        offset,
        "knowledge.retrieval.execution.finished",
        lambda event: event["status"] == "failure"
        and event["data"].get("invocation_id") == invocation,
    )
    _check(
        not any(
            row["event"]["event_type"].startswith("knowledge.usage.")
            and row["event"]["data"].get("invocation_id") == invocation
            for row in _events(offset)
        ),
        "failed retrieval emitted usage",
    )

    attachment_id, _ = _upload_attachment(client, token, "WEGENT-FAILED-INDEX")
    failed_document = _create_document(
        client, token, kb_id, attachment_id, name="failed-events.md"
    )
    failed_id = int(failed_document["id"])
    try:
        _wait_for_index_status(client, token, kb_id, failed_id, "failed")
        _wait_for_event(
            offset,
            "knowledge.index.execution.finished",
            lambda event: event["status"] == "failure"
            and event["document_id"] == failed_id,
        )
    finally:
        _delete_document(client, token, failed_id)


def run() -> None:
    _check(
        EVENTS.is_file(), "the knowledge event probe was not registered in CI services"
    )
    _check(INTERNAL_SERVICE_TOKEN, "the internal service token is required")
    _assert_conversion_protocol_events()
    name = f"e2e-events-{uuid.uuid4().hex[:10]}"
    with _create_client() as client:
        token, user_id = _login(client)
        _create_retrieval_resources(
            client, token, name, embedding_url=EMBEDDING_MODEL_URL
        )
        kb = _create_knowledge_base(client, token, f"E2E-KB-{name}", name)
        kb_id = int(kb["id"])
        document_id = None
        try:
            _assert_transaction_failure(client, token, kb_id, user_id)
            marker = f"WEGENT-EVENT-{uuid.uuid4().hex[:8]}"
            attachment_id = _upload_long_document(client, token, marker)
            offset = EVENTS.stat().st_size
            document = _create_document(
                client, token, kb_id, attachment_id, name="events.md"
            )
            document_id = int(document["id"])
            _wait_for_index_status(client, token, kb_id, document_id, "success")
            index_event = _wait_for_event(
                offset,
                "knowledge.index.execution.finished",
                lambda event: event["status"] == "success"
                and event["document_id"] == document_id,
            )
            chunks = _document_chunks(client, token, document_id)
            _check(len(chunks) >= 2, f"fixture must generate multiple chunks: {chunks}")
            query = str(chunks[0]["content"])[:1900]
            _assert_retrieval_events(
                client, kb_id, document_id, user_id, query, index_event["pid"]
            )
            _assert_failed_events(
                client, token, name, kb_id, document_id, user_id, query
            )
        finally:
            if document_id is not None:
                _delete_scenario_fixtures(
                    client,
                    token,
                    document_id=document_id,
                    knowledge_base_id=kb_id,
                    resource_name=name,
                )
            else:
                _delete_knowledge_base(client, token, kb_id)
                _delete_retrieval_resources(client, token, name)
    print("PASS: knowledge event E2E (real Backend, Runtime, broker and storage)")


if __name__ == "__main__":
    run()
