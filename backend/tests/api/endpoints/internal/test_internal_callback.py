# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP callback is a bounded, transport-only projection relay."""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from app.api.endpoints.internal import callback
from app.core.request_body_limit import CALLBACK_EVENT_BODY_MAX_BYTES
from app.services.execution.stream_client import (
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
)
from shared.models.responses_api import ResponsesAPIStreamEvents


def _event() -> dict:
    return {
        "event_type": ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
        "task_id": 1,
        "subtask_id": 2,
        "message_id": 3,
        "data": {"delta": "hello", "offset": 5},
    }


def test_callback_batch_schema_has_hard_event_limit() -> None:
    event = callback.CallbackRequest.model_validate(_event())

    with pytest.raises(ValidationError):
        TypeAdapter(callback.CallbackBatch).validate_python([event] * 101)


def test_callback_forwards_raw_body_without_web_parsing(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_body = b'{"event_type":"not-even-a-known-event","task_id":1,"subtask_id":2}'
    dispatch = AsyncMock(return_value={"status": "ok", "message": None})
    monkeypatch.setattr(
        callback.stream_execution_client,
        "dispatch_callback_body",
        dispatch,
    )

    response = test_client.post(
        "/api/internal/callback",
        content=raw_body,
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "message": None}
    dispatch.assert_awaited_once_with(raw_body, batch=False)


def test_callback_openapi_keeps_request_contract(test_client: TestClient) -> None:
    schema = test_client.app.openapi()
    callback_schema = schema["paths"]["/api/internal/callback"]["post"]["requestBody"][
        "content"
    ]["application/json"]["schema"]
    batch_schema = schema["paths"]["/api/internal/callback/batch"]["post"][
        "requestBody"
    ]["content"]["application/json"]["schema"]

    assert set(callback_schema["required"]) == {
        "event_type",
        "task_id",
        "subtask_id",
    }
    assert callback_schema["properties"]["event_type"]["maxLength"] == 128
    assert batch_schema["minItems"] == 1
    assert batch_schema["maxItems"] == 100
    assert batch_schema["items"] == callback_schema


def test_callback_batch_forwards_one_raw_frame(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_body = (
        b"["
        + callback.CallbackRequest.model_validate(_event()).model_dump_json().encode()
        + b"]"
    )
    dispatch = AsyncMock(
        return_value={"status": "ok", "message": "Processed 1 events, 0 skipped"}
    )
    monkeypatch.setattr(
        callback.stream_execution_client,
        "dispatch_callback_body",
        dispatch,
    )

    response = test_client.post(
        "/api/internal/callback/batch",
        content=raw_body,
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 200
    dispatch.assert_awaited_once_with(raw_body, batch=True)


def test_callback_body_limit_rejects_before_uds_dispatch(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatch = AsyncMock()
    monkeypatch.setattr(
        callback.stream_execution_client,
        "dispatch_callback_body",
        dispatch,
    )

    response = test_client.post(
        "/api/internal/callback",
        content=b"x" * (CALLBACK_EVENT_BODY_MAX_BYTES + 1),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    dispatch.assert_not_awaited()


def test_worker_validation_error_preserves_http_422(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatch = AsyncMock(
        side_effect=StreamWorkerExecutionError(
            "Invalid callback payload",
            error_code="point_projection_validation",
            details=[
                {
                    "type": "missing",
                    "loc": ("task_id",),
                    "msg": "Field required",
                    "input": {},
                }
            ],
        )
    )
    monkeypatch.setattr(
        callback.stream_execution_client,
        "dispatch_callback_body",
        dispatch,
    )

    response = test_client.post("/api/internal/callback", json={})

    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"] == ["body", "task_id"]


@pytest.mark.parametrize(
    ("error", "expected_status"),
    [
        (StreamWorkerUnavailableError("worker unavailable"), 503),
        (
            StreamWorkerExecutionError(
                "capacity exhausted",
                error_code="point_projection_overloaded",
            ),
            503,
        ),
        (
            StreamWorkerExecutionError(
                "worker timed out",
                error_code="point_projection_timeout",
            ),
            500,
        ),
    ],
)
def test_worker_failures_map_to_stable_http_status(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    expected_status: int,
) -> None:
    monkeypatch.setattr(
        callback.stream_execution_client,
        "dispatch_callback_body",
        AsyncMock(side_effect=error),
    )

    response = test_client.post("/api/internal/callback", json=_event())

    assert response.status_code == expected_status


@pytest.mark.asyncio
async def test_callback_body_admission_is_released_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = Mock()
    monkeypatch.setattr(callback, "release_request_body_admission", release)
    body = b'{"task_id":1}'
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/internal/callback",
            "headers": [],
            "state": {},
        },
        receive,
    )

    assert await callback._read_callback_body(request, max_bytes=100) == body
    release.assert_called_once_with(request.scope)


def test_web_callback_module_has_no_projection_side_effect_owners() -> None:
    source = callback.__file__
    assert source is not None
    text = open(source, encoding="utf-8").read()
    forbidden = {
        "StatusUpdatingEmitter",
        "WebSocketResultEmitter",
        "session_manager",
        "forward_event_to_channel_callbacks",
    }
    assert forbidden.isdisjoint(text.split())
