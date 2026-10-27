"""HTTP transcript transport keeps Executor chunks intact."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.endpoints import runtime_work
from app.schemas.runtime_work import RuntimeTranscriptRequest


def test_http_transcript_response_preserves_transfer_envelope(monkeypatch):
    chunk = {
        "success": True,
        "transcriptProtocolVersion": 2,
        "transfer": {
            "snapshotId": "a" * 64,
            "encoding": "gzip+base64+json",
            "offset": 0,
            "nextOffset": 360 * 1024,
            "totalBytes": 720 * 1024,
            "payload": "cGF5bG9hZA==",
        },
    }
    read = AsyncMock(return_value=chunk)
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "get_runtime_transcript", read
    )
    app = FastAPI()
    app.include_router(runtime_work.router, prefix="/runtime-work")
    app.dependency_overrides[runtime_work.get_db] = lambda: None
    app.dependency_overrides[runtime_work.get_current_user] = lambda: SimpleNamespace(
        id=7
    )
    request = {
        "deviceId": "device-1",
        "taskId": "task-1",
        "projectSession": {"projectId": "project-1", "issueId": "issue-1"},
        "transcriptProtocolVersion": 2,
    }

    with TestClient(app) as client:
        response = client.post("/runtime-work/transcript", json=request)

    assert response.status_code == 200
    assert response.json() == chunk
    assert read.await_args.kwargs["address"].transcript_protocol_version == 2
    assert read.await_args.kwargs["address"].project_session.issue_id == "issue-1"


@pytest.mark.parametrize(
    "fields",
    [
        {"transcriptProtocolVersion": 3},
        {"transcriptTransfer": {"snapshotId": "a" * 64, "offset": 1}},
        {
            "transcriptProtocolVersion": 2,
            "transcriptTransfer": {"snapshotId": "../x", "offset": 1},
        },
        {
            "transcriptProtocolVersion": 2,
            "transcriptTransfer": {"snapshotId": "a" * 64, "offset": 0},
        },
    ],
)
def test_invalid_transfer_requests_are_rejected(fields):
    with pytest.raises(ValidationError):
        RuntimeTranscriptRequest(deviceId="device-1", taskId="task-1", **fields)
