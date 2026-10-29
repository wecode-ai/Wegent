# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP relays transcript chunks without decoding or bypassing session access."""

import asyncio
import base64
import copy
import gzip
import hashlib
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.runtime_transcript_transport import TRANSCRIPT_CHUNK_BYTES
from app.schemas.runtime_work import RuntimeTranscriptRequest
from app.services import runtime_work_service
from tests.services.test_project_comment_execution import scenario  # noqa: F401

SNAPSHOT_ID = "a" * 64


def packed_transcript_chunks() -> tuple[str, list[dict]]:
    """Split high-entropy tool output into multiple valid device packet fixtures."""
    output = "\n".join(
        hashlib.sha256(str(index).encode()).hexdigest() for index in range(12_000)
    )
    packed = {
        "transcript": {
            "taskId": "original-session",
            "workspacePath": "/workspace",
            "runtime": "codex",
            "messages": [],
            "turns": [{"id": "large-turn", "toolOutput": None}],
        },
        "strings": [output],
        "references": [{"path": ["turns", 0, "toolOutput"], "index": 0}],
    }
    compressed = gzip.compress(json.dumps(packed).encode())
    snapshot = hashlib.sha256(compressed).hexdigest()
    chunks = []
    for offset in range(0, len(compressed), TRANSCRIPT_CHUNK_BYTES):
        data = compressed[offset : offset + TRANSCRIPT_CHUNK_BYTES]
        next_offset = offset + len(data)
        chunks.append(
            {
                "success": True,
                "transcriptProtocolVersion": 2,
                "transfer": {
                    "snapshotId": snapshot,
                    "encoding": "gzip+base64+json",
                    "offset": offset,
                    "nextOffset": (
                        next_offset if next_offset < len(compressed) else None
                    ),
                    "totalBytes": len(compressed),
                    "payload": base64.b64encode(data).decode(),
                },
            }
        )
    assert len(chunks) > 1
    return output, chunks


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [None, 1])
async def test_legacy_http_read_uses_device_chunks_and_preserves_json(
    scenario, version, caplog
):
    """Preserve legacy JSON and owner authorization without logging tool output."""
    output, chunks = packed_transcript_chunks()

    async def rpc(**values):
        """Model a device that requires v2 for this oversized transcript."""
        payload = values["payload"]
        if payload.get("transcriptProtocolVersion") != 2:
            return {
                "success": False,
                "code": "runtime_rpc_response_too_large",
                "error": "Response exceeded the transport payload limit",
            }
        offset = payload.get("transcriptTransfer", {}).get("offset", 0)
        return chunks[offset // TRANSCRIPT_CHUNK_BYTES]

    scenario.rpc.side_effect = rpc
    request = bound_request(scenario, limit=20, includeFullContent=True)
    request.transcript_protocol_version = version

    with caplog.at_level("INFO", logger=runtime_work_service.__name__):
        result = await runtime_work_service.get_runtime_transcript(
            db=scenario.db, user_id=scenario.member.id, address=request
        )

    body = result.model_dump(by_alias=True)
    assert "transcriptProtocolVersion" not in body
    assert body["turns"][0]["toolOutput"] == output
    assert request.transcript_protocol_version == version
    assert scenario.rpc.await_count == len(chunks)
    for call in scenario.rpc.await_args_list:
        assert call.kwargs["user_id"] == scenario.owner.id
        assert call.kwargs["device_id"] == "admin-cloud"
        assert call.kwargs["allow_app_device_task_reading"] is True
        assert call.kwargs["payload"]["transcriptProtocolVersion"] == 2
    assert f"total_bytes={chunks[0]['transfer']['totalBytes']}" in caplog.text
    assert "base64_bytes=" in caplog.text
    assert output[:100] not in caplog.text


@pytest.mark.asyncio
async def test_legacy_transfer_rechecks_access_before_reading_next_chunk(scenario):
    """Stop assembly when the original caller loses access after the first chunk."""
    _, chunks = packed_transcript_chunks()

    async def revoke_access(**_values):
        """Revoke the caller's grant as the device returns its first chunk."""
        scenario.db.delete(scenario.grant)
        scenario.db.commit()
        return chunks[0]

    scenario.rpc.side_effect = revoke_access
    request = bound_request(scenario)
    request.transcript_protocol_version = None

    with pytest.raises(HTTPException) as error:
        await runtime_work_service.get_runtime_transcript(
            db=scenario.db, user_id=scenario.member.id, address=request
        )

    assert error.value.status_code == 404
    assert scenario.rpc.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["snapshot", "offset", "base64", "digest"])
async def test_legacy_transfer_rejects_inconsistent_or_corrupt_packets(
    scenario, failure
):
    """Return a safe gateway error for corrupt data or inconsistent continuations."""
    output, packets = packed_transcript_chunks()
    chunks = copy.deepcopy(packets)
    if failure == "snapshot":
        chunks[1]["transfer"]["snapshotId"] = "b" * 64
    elif failure == "offset":
        chunks[1]["transfer"]["offset"] = 0
    elif failure == "base64":
        chunks[0]["transfer"]["payload"] = "!invalid!"
    else:
        for chunk in chunks:
            chunk["transfer"]["snapshotId"] = "c" * 64
    scenario.rpc.side_effect = chunks
    request = bound_request(scenario)
    request.transcript_protocol_version = None

    with pytest.raises(HTTPException) as error:
        await runtime_work_service.get_runtime_transcript(
            db=scenario.db, user_id=scenario.member.id, address=request
        )

    assert error.value.status_code == 502
    assert error.value.detail == "Runtime returned an invalid conversation response"
    assert output not in str(error.value.detail)


@pytest.mark.asyncio
async def test_legacy_transfer_has_one_end_to_end_timeout(scenario, monkeypatch):
    """Cancel a stalled device read within the existing whole-transfer budget."""
    cancelled = asyncio.Event()

    async def stalled(**_values):
        """Keep the device request pending until the aggregation timeout cancels it."""
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    scenario.rpc.side_effect = stalled
    monkeypatch.setattr(
        runtime_work_service, "RUNTIME_TRANSCRIPT_TIMEOUT_SECONDS", 0.02
    )
    request = bound_request(scenario)
    request.transcript_protocol_version = None

    with pytest.raises(HTTPException) as error:
        await runtime_work_service.get_runtime_transcript(
            db=scenario.db, user_id=scenario.member.id, address=request
        )

    assert error.value.status_code == 502
    assert error.value.detail == "Runtime transcript transfer timed out"
    assert cancelled.is_set()
    assert scenario.rpc.await_count == 1


def chunk_response(offset: int = 0) -> dict:
    return {
        "success": True,
        "transcriptProtocolVersion": 2,
        "transfer": {
            "snapshotId": SNAPSHOT_ID,
            "encoding": "gzip+base64+json",
            "offset": offset,
            "nextOffset": None,
            "totalBytes": offset + 1,
            "payload": "YQ==",
        },
    }


def bound_request(scenario, **values) -> RuntimeTranscriptRequest:
    return RuntimeTranscriptRequest(
        deviceId="admin-cloud",
        taskId="original-session",
        projectSession={
            "projectId": str(scenario.project.id),
            "issueId": scenario.issue.id,
        },
        transcriptProtocolVersion=2,
        **values,
    )


@pytest.mark.asyncio
async def test_project_transcript_resolves_binding_for_each_chunk(scenario):
    first = chunk_response()
    first["transfer"].update(
        nextOffset=TRANSCRIPT_CHUNK_BYTES,
        totalBytes=TRANSCRIPT_CHUNK_BYTES + 1,
        payload="YWFh" * (TRANSCRIPT_CHUNK_BYTES // 3),
    )
    continuation = chunk_response(TRANSCRIPT_CHUNK_BYTES)
    scenario.rpc.side_effect = [first, continuation]
    options = {
        "limit": 5,
        "beforeCursor": "search-match-1",
        "refresh": True,
        "navigationOnly": False,
        "workspacePath": "/forged",
        "runtimeHandle": {"threadId": "private-thread"},
    }

    initial = await runtime_work_service.get_runtime_transcript(
        db=scenario.db,
        user_id=scenario.member.id,
        address=bound_request(scenario, **options),
    )
    cursor = {"snapshotId": SNAPSHOT_ID, "offset": TRANSCRIPT_CHUNK_BYTES}
    continued = await runtime_work_service.get_runtime_transcript(
        db=scenario.db,
        user_id=scenario.member.id,
        address=bound_request(scenario, **options, transcriptTransfer=cursor),
    )

    assert initial.model_dump(by_alias=True) == first
    assert continued.model_dump(by_alias=True) == continuation
    assert scenario.rpc.await_count == 2
    for call, transfer in zip(scenario.rpc.await_args_list, [None, cursor]):
        assert call.kwargs == {
            "user_id": scenario.owner.id,
            "device_id": "admin-cloud",
            "method": "runtime.tasks.transcript",
            "payload": {
                "deviceId": "admin-cloud",
                "taskId": "original-session",
                "limit": 5,
                "beforeCursor": "search-match-1",
                "refresh": True,
                "navigationOnly": False,
                "transcriptProtocolVersion": 2,
                **({"transcriptTransfer": transfer} if transfer else {}),
            },
            "timeout_seconds": 30,
            "allow_app_device_task_reading": True,
        }

    # A valid snapshot identifier never grants access after the binding changes.
    request = bound_request(scenario, transcriptTransfer=cursor)
    request.project_session.issue_id = "unbound-issue"
    with pytest.raises(HTTPException) as error:
        await runtime_work_service.get_runtime_transcript(
            db=scenario.db, user_id=scenario.member.id, address=request
        )
    assert error.value.status_code == 404
    assert scenario.rpc.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_fields",
    [
        {"transcriptProtocolVersion": 3},
        {"transfer": {}},
        {"transfer": {**chunk_response()["transfer"], "offset": "0"}},
        {"transfer": {**chunk_response()["transfer"], "totalBytes": 0}},
        {"transfer": {**chunk_response()["transfer"], "nextOffset": 1}},
        {"transfer": {**chunk_response()["transfer"], "payload": ""}},
        {"transfer": {**chunk_response()["transfer"], "encoding": "json"}},
    ],
)
async def test_invalid_versioned_transcript_returns_gateway_error(
    scenario, invalid_fields
):
    scenario.rpc.return_value = {**chunk_response(), **invalid_fields}

    with pytest.raises(HTTPException) as error:
        await runtime_work_service.get_runtime_transcript(
            db=scenario.db,
            user_id=scenario.member.id,
            address=bound_request(scenario),
        )

    assert error.value.status_code == 502
    assert error.value.detail == "Runtime returned an invalid conversation response"


@pytest.mark.parametrize(
    "fields",
    [
        {"transcriptProtocolVersion": 3},
        {"transcriptProtocolVersion": "2"},
        {"transcriptProtocolVersion": True},
        {
            "transcriptTransfer": {
                "snapshotId": SNAPSHOT_ID,
                "offset": TRANSCRIPT_CHUNK_BYTES,
            }
        },
        {
            "transcriptProtocolVersion": 2,
            "transcriptTransfer": {
                "snapshotId": "../private",
                "offset": TRANSCRIPT_CHUNK_BYTES,
            },
        },
        {
            "transcriptProtocolVersion": 2,
            "transcriptTransfer": {"snapshotId": SNAPSHOT_ID, "offset": 1},
        },
    ],
)
def test_transcript_request_rejects_invalid_transfer(fields):
    with pytest.raises(ValidationError):
        RuntimeTranscriptRequest(deviceId="cloud-device", taskId="task-1", **fields)


def test_transcript_endpoint_preserves_opaque_chunk_and_request_fields(
    test_client, test_token, monkeypatch
):
    from app.api.endpoints import runtime_work

    response_payload = chunk_response(TRANSCRIPT_CHUNK_BYTES)
    service = AsyncMock(return_value=response_payload)
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "get_runtime_transcript", service
    )
    cursor = {"snapshotId": SNAPSHOT_ID, "offset": TRANSCRIPT_CHUNK_BYTES}
    request_payload = {
        "deviceId": "cloud-device",
        "taskId": "task-1",
        "projectSession": {"projectId": "project-1", "issueId": "issue-1"},
        "transcriptProtocolVersion": 2,
        "transcriptTransfer": cursor,
        "refresh": True,
        "navigationOnly": True,
    }

    response = test_client.post(
        "/api/runtime-work/transcript",
        headers={"Authorization": f"Bearer {test_token}"},
        json=request_payload,
    )

    assert response.status_code == 200
    assert response.json() == response_payload
    assert service.await_args.kwargs["address"].model_dump(
        by_alias=True, exclude_none=True
    ) == {
        **request_payload,
        "includeFullContent": False,
        "conversationContextOnly": False,
    }
