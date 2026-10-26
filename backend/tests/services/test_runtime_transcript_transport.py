# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP relays transcript chunks without decoding or bypassing session access."""

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.runtime_transcript_transport import TRANSCRIPT_CHUNK_BYTES
from app.schemas.runtime_work import RuntimeTranscriptRequest
from app.services import runtime_work_service
from tests.services.test_project_comment_execution import scenario  # noqa: F401

SNAPSHOT_ID = "a" * 64


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
