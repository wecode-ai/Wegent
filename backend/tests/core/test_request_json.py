# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, TypeAdapter
from starlette.requests import Request

from app.core import request_json
from app.core.request_json import validate_json_request


def _request(body: bytes, content_type: str = "application/json") -> Request:
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/test",
            "headers": [(b"content-type", content_type.encode())],
        },
        receive,
    )


async def _wait_until_set(event: threading.Event) -> None:
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("worker did not start")


@pytest.mark.asyncio
async def test_validation_runs_off_loop_and_loop_remains_responsive() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []

    class BlockingValidator:
        def validate_json(self, body: bytes) -> dict[str, int]:
            worker_thread_ids.append(threading.get_ident())
            started.set()
            release.wait(timeout=5)
            return {"size": len(body)}

    loop_thread_id = threading.get_ident()
    task = asyncio.create_task(
        validate_json_request(
            _request(b'{"value":1}'),
            BlockingValidator(),  # type: ignore[arg-type]
            max_bytes=100,
        )
    )
    try:
        await _wait_until_set(started)
        ticked = asyncio.Event()
        asyncio.get_running_loop().call_soon(ticked.set)
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        assert not task.done()
        assert worker_thread_ids == [worker_thread_ids[0]]
        assert worker_thread_ids[0] != loop_thread_id
    finally:
        release.set()

    assert await task == {"size": 11}


@pytest.mark.asyncio
async def test_validation_errors_keep_body_location() -> None:
    class Payload(BaseModel):
        value: int

    with pytest.raises(RequestValidationError) as exc_info:
        await validate_json_request(
            _request(b'{"value":"bad"}'),
            TypeAdapter(Payload),
            max_bytes=100,
        )

    assert exc_info.value.errors()[0]["loc"] == ("body", "value")


@pytest.mark.asyncio
async def test_validation_error_projection_runs_off_loop(monkeypatch) -> None:
    class Payload(BaseModel):
        value: int

    worker_thread_ids: list[int] = []
    original = request_json._body_validation_errors

    def capture_thread(exc):
        worker_thread_ids.append(threading.get_ident())
        return original(exc)

    monkeypatch.setattr(request_json, "_body_validation_errors", capture_thread)
    loop_thread_id = threading.get_ident()

    with pytest.raises(RequestValidationError):
        await validate_json_request(
            _request(b'{"value":"bad"}'),
            TypeAdapter(Payload),
            max_bytes=100,
        )

    assert worker_thread_ids
    assert worker_thread_ids[0] != loop_thread_id


@pytest.mark.asyncio
async def test_oversize_body_is_rejected_before_validation() -> None:
    class NeverCalledValidator:
        def validate_json(self, body: bytes) -> None:
            raise AssertionError("validator must not run")

    with pytest.raises(HTTPException) as exc_info:
        await validate_json_request(
            _request(b"12345"),
            NeverCalledValidator(),  # type: ignore[arg-type]
            max_bytes=4,
        )

    assert exc_info.value.status_code == 413
