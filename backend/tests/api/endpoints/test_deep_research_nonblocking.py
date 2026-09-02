# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.routing import APIRoute
from starlette.requests import Request

from app.api.endpoints import deep_research


def _request(body: bytes) -> Request:
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/deep-research",
            "headers": [(b"content-type", b"application/json")],
        },
        receive,
    )


def test_all_deep_research_bodies_use_explicit_decoder_dependencies() -> None:
    expected_decoders = {
        "/deep-research": deep_research._decode_deep_research_create_request,
        "/deep-research/{interaction_id}/status": (
            deep_research._decode_deep_research_status_request
        ),
        "/deep-research/{interaction_id}/stream": (
            deep_research._decode_deep_research_stream_request
        ),
    }

    routes = {
        route.path: route
        for route in deep_research.router.routes
        if isinstance(route, APIRoute)
    }
    for path, decoder in expected_decoders.items():
        route = routes[path]
        assert route.dependant.body_params == []
        assert decoder in {
            dependency.call for dependency in route.dependant.dependencies
        }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("decoder", "expected_type", "payload"),
    [
        (
            deep_research._decode_deep_research_create_request,
            deep_research.DeepResearchCreateRequest,
            b'{"model_config":{"api_key":"key","base_url":"https://example.com"},'
            b'"input":"question"}',
        ),
        (
            deep_research._decode_deep_research_status_request,
            deep_research.DeepResearchStatusRequest,
            b'{"model_config":{"api_key":"key","base_url":"https://example.com"}}',
        ),
        (
            deep_research._decode_deep_research_stream_request,
            deep_research.DeepResearchStreamRequest,
            b'{"model_config":{"api_key":"key","base_url":"https://example.com"}}',
        ),
    ],
)
async def test_deep_research_decoders_validate_raw_json_off_route_body_parsing(
    decoder,
    expected_type,
    payload,
) -> None:
    result = await decoder(_request(payload))

    assert isinstance(result, expected_type)


@pytest.mark.asyncio
async def test_deep_research_payload_codec_is_off_loop_and_bytes_are_relayed(
    monkeypatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []
    original = deep_research._deep_research_stream_payload

    def blocking_payload(interaction_id, model_config):
        worker_thread_ids.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return original(interaction_id, model_config)

    calls = []

    async def worker_stream(operation, payload):
        calls.append((operation, payload))
        yield b'event: content.delta\ndata: {"value":1}\n\n'
        yield b'event: content.delta\ndata: {"value":2}\n\n'

    monkeypatch.setattr(
        deep_research,
        "_deep_research_stream_payload",
        blocking_payload,
    )
    monkeypatch.setattr(
        deep_research.web_stream_worker_client,
        "stream",
        worker_stream,
    )
    request_body = deep_research.DeepResearchStreamRequest.model_validate(
        {
            "model_config": {
                "api_key": "key",
                "base_url": "https://example.com",
            }
        }
    )
    endpoint = deep_research.stream_deep_research_result.__wrapped__
    loop_thread_id = threading.get_ident()
    task = asyncio.create_task(
        endpoint(
            request=MagicMock(),
            interaction_id="interaction",
            request_body=request_body,
            auth_context=SimpleNamespace(user=SimpleNamespace(id=1)),
        )
    )
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(0.005)
        assert started.is_set()
        ticked = asyncio.Event()
        asyncio.get_running_loop().call_soon(ticked.set)
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        assert not task.done()
        assert worker_thread_ids[0] != loop_thread_id
    finally:
        release.set()

    response = await task
    frames = [frame async for frame in response.body_iterator]
    assert frames == [
        b'event: content.delta\ndata: {"value":1}\n\n',
        b'event: content.delta\ndata: {"value":2}\n\n',
    ]
    assert calls[0][0] == "deep_research"
    assert calls[0][1]["interaction_id"] == "interaction"
