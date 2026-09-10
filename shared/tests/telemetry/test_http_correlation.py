"""HTTP and log correlation across concurrent requests and unsampled spans."""

import asyncio
import logging

import httpx
import pytest
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

from shared.logger import RequestIdFilter
from shared.telemetry.context.span import _request_id_var
from shared.telemetry.http import internal_http_event_hooks
from shared.utils.http_client import _inject_trace_headers, traced_async_client


def span(trace_id=123, span_id=456):
    return NonRecordingSpan(SpanContext(trace_id, span_id, False, TraceFlags(0)))


@pytest.mark.parametrize("active_span", [trace.INVALID_SPAN, span()])
def test_request_id_logging_is_independent_of_otel(active_span):
    record = logging.LogRecord("test", logging.INFO, __file__, 1, "test", (), None)
    token = _request_id_var.set("request-1")
    try:
        with trace.use_span(active_span):
            RequestIdFilter().filter(record)
            assert record.request_id == "request-1"
    finally:
        _request_id_var.reset(token)


def test_request_id_is_sent_when_trace_injection_fails(monkeypatch):
    import shared.telemetry.context as context

    def unavailable(_headers):
        raise ImportError("optional telemetry is unavailable")

    monkeypatch.setattr(context, "inject_trace_context_to_headers", unavailable)
    token = _request_id_var.set("request-without-otel")
    try:
        assert _inject_trace_headers({})["X-Request-ID"] == "request-without-otel"
    finally:
        _request_id_var.reset(token)


@pytest.mark.asyncio
async def test_pooled_client_keeps_concurrent_request_contexts_separate():
    seen = []

    async def handle(request):
        await asyncio.sleep(0)
        seen.append(
            (request.headers.get("X-Request-ID"), request.headers.get("traceparent"))
        )
        return httpx.Response(200, json={})

    async with traced_async_client(
        transport=httpx.MockTransport(handle),
        event_hooks=internal_http_event_hooks(),
    ) as client:

        async def send(number):
            token = _request_id_var.set(f"request-{number}")
            try:
                with trace.use_span(span(number, number + 10)):
                    await client.get("http://backend/internal/history")
            finally:
                _request_id_var.reset(token)

        await asyncio.gather(*(send(number) for number in range(1, 11)))
        with trace.use_span(trace.INVALID_SPAN):
            token = _request_id_var.set(None)
            try:
                await client.get("http://backend/internal/history")
            finally:
                _request_id_var.reset(token)
    assert set(seen[:-1]) == {
        (f"request-{number}", f"00-{number:032x}-{number + 10:016x}-00")
        for number in range(1, 11)
    }
    assert seen[-1] == (None, None)


@pytest.mark.asyncio
async def test_connection_failure_logs_phase_and_request_id(caplog):
    async def fail(request):
        callback = request.extensions["trace"]
        await callback("connection.connect_tcp.started", {})
        error = httpx.ConnectTimeout("timed out", request=request)
        await callback("connection.connect_tcp.failed", {"exception": error})
        raise error

    token = _request_id_var.set("request-timeout")
    try:
        with caplog.at_level(logging.INFO):
            async with traced_async_client(
                transport=httpx.MockTransport(fail),
                event_hooks=internal_http_event_hooks(),
            ) as client:
                with pytest.raises(httpx.ConnectTimeout):
                    await client.get("http://backend/internal/history")
    finally:
        _request_id_var.reset(token)
    message = next(r.message for r in caplog.records if "state=failed" in r.message)
    assert "phase=connection.connect_tcp" in message
    assert "error_type=ConnectTimeout" in message
    assert "request_id=request-timeout" in message
