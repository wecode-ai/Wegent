# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from pydantic import TypeAdapter
from starlette.requests import Request

from app.core.request_body_limit import (
    CALLBACK_BATCH_BODY_MAX_BYTES,
    CALLBACK_EVENT_BODY_MAX_BYTES,
    DEEP_RESEARCH_BODY_MAX_BYTES,
    MULTIPART_FORM_OVERHEAD_MAX_BYTES,
    PROMPT_DRAFT_BODY_MAX_BYTES,
    RequestBodyLimitMiddleware,
    RequestBodyTooLargeError,
    callback_request_body_limits,
    get_buffered_request_body,
    multipart_request_body_limit_patterns,
    multipart_request_body_limits,
    streaming_request_body_limit_patterns,
    streaming_request_body_limits,
)
from app.core.request_json import validate_json_request


def _http_scope(path: str, headers: list[tuple[bytes, bytes]]) -> dict[str, Any]:
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }


def _receive_messages(
    messages: list[dict[str, Any]],
) -> Callable[[], Awaitable[dict[str, Any]]]:
    queued = iter(messages)

    async def receive() -> dict[str, Any]:
        return next(queued)

    return receive


def test_callback_body_limits_cover_actual_mounted_paths() -> None:
    limits = callback_request_body_limits("/api")

    assert limits["/api/internal/callback"] == CALLBACK_EVENT_BODY_MAX_BYTES
    assert limits["/api/internal/callback/batch"] == CALLBACK_BATCH_BODY_MAX_BYTES


def test_streaming_body_limits_cover_exact_and_dynamic_mounted_paths() -> None:
    exact_limits = streaming_request_body_limits("/api")
    patterns = streaming_request_body_limit_patterns("/api")
    middleware = RequestBodyLimitMiddleware(
        lambda scope, receive, send: None,
        exact_limits,
        patterns,
    )

    assert middleware._resolve_limit("/api/runtime-work/llm-responses-proxy/responses")
    assert (
        middleware._resolve_limit("/api/v1/deep-research")
        == DEEP_RESEARCH_BODY_MAX_BYTES
    )
    assert (
        middleware._resolve_limit("/api/tasks/42/prompt-drafts/generate/stream")
        == PROMPT_DRAFT_BODY_MAX_BYTES
    )
    assert (
        middleware._resolve_limit("/api/v1/deep-research/interaction-1/stream")
        == DEEP_RESEARCH_BODY_MAX_BYTES
    )
    assert (
        middleware._resolve_limit("/api/v1/deep-research/interaction-1/status")
        == DEEP_RESEARCH_BODY_MAX_BYTES
    )
    assert (
        middleware._resolve_limit("/api/tasks/not-an-id/prompt-drafts/generate/stream")
        is None
    )


def test_attachment_multipart_limits_cover_both_public_upload_paths() -> None:
    limits = multipart_request_body_limits(
        "/api",
        max_attachment_file_bytes=100 * 1024 * 1024,
    )
    expected = 100 * 1024 * 1024 + MULTIPART_FORM_OVERHEAD_MAX_BYTES

    assert limits["/api/attachments/upload"] == expected
    assert limits["/api/v1/attachments/upload"] == expected


def test_multipart_limits_cover_every_mounted_upload_shape() -> None:
    exact = multipart_request_body_limits(
        "/api",
        max_attachment_file_bytes=100,
        max_feedback_bundle_bytes=250,
        max_plugin_package_bytes=50,
        max_skill_package_bytes=10,
        max_team_icon_bytes=2,
    )
    patterns = multipart_request_body_limit_patterns(
        "/api",
        max_cloud_file_bytes=2048,
        max_delivery_asset_bytes=2048,
        max_skill_package_bytes=10,
        max_work_queue_file_bytes=100,
    )
    middleware = RequestBodyLimitMiddleware(
        lambda scope, receive, send: None,
        {},
        multipart_path_limits=exact,
        multipart_path_patterns=patterns,
    )

    exact_paths = (
        "/api/admin/public-teams/icon-assets",
        "/api/v1/feedback",
        "/api/attachments/upload",
        "/api/v1/attachments/upload",
        "/api/plugins/upload",
        "/api/v1/kinds/skills/upload",
        "/api/v1/kinds/skills/public/upload",
    )
    dynamic_paths = (
        "/api/v1/cloud-projects/42/files",
        "/api/v1/loop-items/item-1/attachments",
        "/api/v1/deliveries/delivery-1/assets",
        "/api/work-queues/by-name/review/messages/ingest",
        "/api/v1/kinds/skills/public/42/upload",
        "/api/v1/kinds/skills/42",
    )

    assert all(middleware._resolve_multipart_limit(path) for path in exact_paths)
    assert all(middleware._resolve_multipart_limit(path) for path in dynamic_paths)
    assert middleware._resolve_multipart_limit("/api/unregistered/upload") is None


@pytest.mark.asyncio
async def test_dynamic_path_chunked_body_over_limit_is_rejected() -> None:
    path = "/api/tasks/42/prompt-drafts/generate/stream"
    downstream_calls = 0
    sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        nonlocal downstream_calls
        downstream_calls += 1

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    receive = _receive_messages(
        [
            {
                "type": "http.request",
                "body": b"x" * PROMPT_DRAFT_BODY_MAX_BYTES,
                "more_body": True,
            },
            {"type": "http.request", "body": b"x", "more_body": False},
        ]
    )
    middleware = RequestBodyLimitMiddleware(
        downstream,
        streaming_request_body_limits("/api"),
        streaming_request_body_limit_patterns("/api"),
    )
    await middleware(_http_scope(path, []), receive, send)

    assert downstream_calls == 0
    assert sent[0]["status"] == 413


@pytest.mark.asyncio
async def test_content_length_over_limit_never_enters_downstream_app() -> None:
    path = "/api/internal/callback"
    downstream_calls = 0
    receive_calls = 0
    sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        nonlocal downstream_calls
        downstream_calls += 1

    async def receive() -> dict[str, Any]:
        nonlocal receive_calls
        receive_calls += 1
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(downstream, {path: 8})
    await middleware(
        _http_scope(path, [(b"content-length", b"9")]),
        receive,
        send,
    )

    assert downstream_calls == 0
    assert receive_calls == 0
    assert sent[0]["status"] == 413


@pytest.mark.asyncio
async def test_chunked_body_over_limit_never_enters_downstream_app() -> None:
    path = "/api/internal/callback/batch"
    downstream_calls = 0
    sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        nonlocal downstream_calls
        downstream_calls += 1

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    receive = _receive_messages(
        [
            {"type": "http.request", "body": b"12345", "more_body": True},
            {"type": "http.request", "body": b"6789", "more_body": False},
        ]
    )
    middleware = RequestBodyLimitMiddleware(downstream, {path: 8})
    await middleware(_http_scope(path, []), receive, send)

    assert downstream_calls == 0
    assert sent[0]["status"] == 413


@pytest.mark.asyncio
async def test_admitted_chunked_body_is_replayed_without_reordering() -> None:
    path = "/api/internal/callback"
    received_body = bytearray()
    sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        while True:
            message = await receive()
            received_body.extend(message.get("body", b""))
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    receive = _receive_messages(
        [
            {"type": "http.request", "body": b"1234", "more_body": True},
            {"type": "http.request", "body": b"5678", "more_body": False},
        ]
    )
    middleware = RequestBodyLimitMiddleware(downstream, {path: 8})
    await middleware(_http_scope(path, []), receive, send)

    assert bytes(received_body) == b"12345678"
    assert sent[0]["status"] == 204


@pytest.mark.asyncio
async def test_bounded_body_is_exposed_without_second_stream_read() -> None:
    path = "/api/ordinary-json"
    scope = _http_scope(path, [])
    observed: list[bytes | None] = []

    async def downstream(scope, receive, send) -> None:
        observed.append(get_buffered_request_body(scope))
        message = await receive()
        assert message["body"] == b'{"task_id":1}'

    middleware = RequestBodyLimitMiddleware(downstream, {})
    await middleware(
        scope,
        _receive_messages([{"type": "http.request", "body": b'{"task_id":1}'}]),
        lambda message: asyncio.sleep(0),
    )

    assert observed == [b'{"task_id":1}']
    assert get_buffered_request_body(scope) is None


@pytest.mark.asyncio
async def test_body_admission_rejects_before_reading_another_body() -> None:
    path = "/api/internal/callback"
    first_entered = asyncio.Event()
    finish_first = asyncio.Event()
    second_receive_calls = 0
    second_sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        first_entered.set()
        await finish_first.wait()

    async def second_receive() -> dict[str, Any]:
        nonlocal second_receive_calls
        second_receive_calls += 1
        return {"type": "http.request", "body": b"x", "more_body": False}

    async def second_send(message: dict[str, Any]) -> None:
        second_sent.append(message)

    middleware = RequestBodyLimitMiddleware(
        downstream,
        {path: 8},
        max_in_flight_requests=1,
        max_in_flight_bytes=8,
    )
    first_task = asyncio.create_task(
        middleware(
            _http_scope(path, [(b"content-length", b"8")]),
            _receive_messages([{"type": "http.request", "body": b"12345678"}]),
            lambda message: asyncio.sleep(0),
        )
    )
    try:
        await asyncio.wait_for(first_entered.wait(), timeout=1)
        await middleware(
            _http_scope(path, [(b"content-length", b"1")]),
            second_receive,
            second_send,
        )
    finally:
        finish_first.set()
        await first_task

    assert second_receive_calls == 0
    assert second_sent[0]["status"] == 503
    assert (b"retry-after", b"1") in second_sent[0]["headers"]


@pytest.mark.asyncio
async def test_json_validation_releases_admission_before_long_response() -> None:
    path = "/api/v1/responses"
    first_validated = asyncio.Event()
    finish_first = asyncio.Event()
    sent: list[dict[str, Any]] = []
    validator = TypeAdapter(dict[str, int])

    async def downstream(scope, receive, send) -> None:
        payload = await validate_json_request(
            Request(scope, receive),
            validator,
            max_bytes=32,
        )
        if payload["hold"]:
            first_validated.set()
            await finish_first.wait()
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(
        downstream,
        {path: 32},
        max_in_flight_requests=1,
        max_in_flight_bytes=32,
    )
    first_body = b'{"hold":1}'
    first_task = asyncio.create_task(
        middleware(
            _http_scope(
                path,
                [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(first_body)).encode()),
                ],
            ),
            _receive_messages([{"type": "http.request", "body": first_body}]),
            send,
        )
    )
    try:
        await asyncio.wait_for(first_validated.wait(), timeout=1)
        second_body = b'{"hold":0}'
        await asyncio.wait_for(
            middleware(
                _http_scope(
                    path,
                    [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(second_body)).encode()),
                    ],
                ),
                _receive_messages([{"type": "http.request", "body": second_body}]),
                send,
            ),
            timeout=1,
        )
        assert not first_task.done()
    finally:
        finish_first.set()
        await first_task

    assert [message["status"] for message in sent if "status" in message] == [
        204,
        204,
    ]


@pytest.mark.asyncio
async def test_unlisted_path_is_still_rejected_by_global_body_limit() -> None:
    path = "/api/ordinary-json"
    downstream_calls = 0
    receive_calls = 0
    sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        nonlocal downstream_calls
        downstream_calls += 1

    async def receive() -> dict[str, Any]:
        nonlocal receive_calls
        receive_calls += 1
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(
        downstream,
        {},
        default_body_limit=8,
    )
    await middleware(
        _http_scope(path, [(b"content-length", b"9")]),
        receive,
        send,
    )

    assert downstream_calls == 0
    assert receive_calls == 0
    assert sent[0]["status"] == 413


@pytest.mark.asyncio
async def test_multipart_body_is_limited_without_prebuffering() -> None:
    path = "/api/upload"
    allow_second_chunk = asyncio.Event()
    received: list[bytes] = []

    async def downstream(scope, receive, send) -> None:
        first = await receive()
        received.append(first["body"])
        allow_second_chunk.set()
        second = await receive()
        received.append(second["body"])

    receive_calls = 0

    async def receive() -> dict[str, Any]:
        nonlocal receive_calls
        receive_calls += 1
        if receive_calls == 1:
            return {"type": "http.request", "body": b"1234", "more_body": True}
        await allow_second_chunk.wait()
        return {"type": "http.request", "body": b"5678", "more_body": False}

    middleware = RequestBodyLimitMiddleware(
        downstream,
        {},
        multipart_body_limit=8,
    )
    await asyncio.wait_for(
        middleware(
            _http_scope(
                path,
                [(b"content-type", b"multipart/form-data; boundary=test")],
            ),
            receive,
            lambda message: asyncio.sleep(0),
        ),
        timeout=1,
    )

    assert received == [b"1234", b"5678"]


@pytest.mark.asyncio
async def test_chunked_multipart_over_global_limit_raises_413() -> None:
    async def downstream(scope, receive, send) -> None:
        while True:
            message = await receive()
            if not message.get("more_body", False):
                return

    middleware = RequestBodyLimitMiddleware(
        downstream,
        {},
        multipart_body_limit=8,
    )

    with pytest.raises(RequestBodyTooLargeError) as raised:
        await middleware(
            _http_scope(
                "/api/upload",
                [(b"content-type", b"multipart/form-data; boundary=test")],
            ),
            _receive_messages(
                [
                    {
                        "type": "http.request",
                        "body": b"12345",
                        "more_body": True,
                    },
                    {
                        "type": "http.request",
                        "body": b"6789",
                        "more_body": False,
                    },
                ]
            ),
            lambda message: asyncio.sleep(0),
        )

    assert raised.value.status_code == 413


@pytest.mark.asyncio
async def test_attachment_path_uses_smaller_streamed_multipart_limit() -> None:
    path = "/api/attachments/upload"
    downstream_calls = 0
    sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        nonlocal downstream_calls
        downstream_calls += 1

    async def receive() -> dict[str, Any]:
        raise AssertionError("oversized Content-Length must be rejected before read")

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(
        downstream,
        {},
        multipart_path_limits={path: 8},
        multipart_body_limit=1024,
    )
    await middleware(
        _http_scope(
            path,
            [
                (b"content-type", b"multipart/form-data; boundary=test"),
                (b"content-length", b"9"),
            ],
        ),
        receive,
        send,
    )

    assert downstream_calls == 0
    assert sent[0]["status"] == 413


@pytest.mark.asyncio
async def test_multipart_admission_rejects_parallel_parser_before_body_read() -> None:
    first_entered = asyncio.Event()
    finish_first = asyncio.Event()
    second_receive_calls = 0
    second_sent: list[dict[str, Any]] = []

    async def downstream(scope, receive, send) -> None:
        first_entered.set()
        await finish_first.wait()

    async def second_receive() -> dict[str, Any]:
        nonlocal second_receive_calls
        second_receive_calls += 1
        return {"type": "http.request", "body": b"x", "more_body": False}

    async def second_send(message: dict[str, Any]) -> None:
        second_sent.append(message)

    middleware = RequestBodyLimitMiddleware(
        downstream,
        {},
        multipart_body_limit=8,
        max_in_flight_multipart_requests=1,
    )
    scope = _http_scope(
        "/api/upload",
        [(b"content-type", b"multipart/form-data; boundary=test")],
    )
    first_task = asyncio.create_task(
        middleware(
            scope,
            _receive_messages(
                [{"type": "http.request", "body": b"x", "more_body": False}]
            ),
            lambda message: asyncio.sleep(0),
        )
    )
    try:
        await asyncio.wait_for(first_entered.wait(), timeout=1)
        await middleware(
            _http_scope(
                "/api/upload",
                [(b"content-type", b"multipart/form-data; boundary=test")],
            ),
            second_receive,
            second_send,
        )
    finally:
        finish_first.set()
        await first_task

    assert second_receive_calls == 0
    assert second_sent[0]["status"] == 503
    assert (b"retry-after", b"1") in second_sent[0]["headers"]
