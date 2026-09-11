"""Verify correlation hooks are used by every internal history/guidance call."""

import httpx
import pytest
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext

from chat_shell.services.guidance import RemoteGuidanceQueueClient
from chat_shell.storage.remote import RemoteHistoryStore
from shared.telemetry.context.span import _request_id_var


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_token", ["", "internal-test-token"])
async def test_history_patch_and_guidance_preserve_request_and_trace(
    monkeypatch, auth_token
):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"messages": [], "item": None, "success": True})

    original_client = httpx.AsyncClient

    def client(**kwargs):
        return original_client(**kwargs, transport=httpx.MockTransport(handle))

    monkeypatch.setattr(httpx, "AsyncClient", client)
    history = RemoteHistoryStore("http://backend/api/internal", auth_token=auth_token)
    guidance = RemoteGuidanceQueueClient(
        "http://backend/api/internal", auth_token=auth_token
    )
    token = _request_id_var.set("req-412317010590")
    context = SpanContext(123, 456, False)
    try:
        with trace.use_span(NonRecordingSpan(context)):
            await history.get_history("task-412317010581")
            await history.update_message("task-412317010581", "412317010589", "继续")
            await guidance.consume(412317010581, 412317010590)
            await guidance.expire(412317010581, 412317010590)
    finally:
        _request_id_var.reset(token)
        await history.close()
        if guidance._client is not None:
            await guidance._client.aclose()
    assert [request.method for request in requests] == ["GET", "PATCH", "POST", "POST"]
    assert all(r.headers["X-Request-ID"] == "req-412317010590" for r in requests)
    expected_authorization = f"Bearer {auth_token}" if auth_token else None
    assert all(
        r.headers.get("Authorization") == expected_authorization for r in requests
    )
    assert all(
        r.headers["traceparent"] == f"00-{123:032x}-{456:016x}-00" for r in requests
    )
