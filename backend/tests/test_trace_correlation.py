"""Exercise the real service middleware and HTTPX propagation in process."""

import httpx
import pytest
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from shared.telemetry.context.span import get_request_id
from shared.telemetry.http import internal_http_event_hooks
from shared.utils.http_client import traced_async_client


@pytest.mark.asyncio
async def test_chat_shell_to_backend_uses_one_trace_and_distinct_spans():
    from app.main import create_app as create_backend
    from chat_shell.main import create_app as create_chat_shell

    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    backend = create_backend()
    chat_shell = create_chat_shell()
    FastAPIInstrumentor.instrument_app(backend, tracer_provider=provider)
    FastAPIInstrumentor.instrument_app(chat_shell, tracer_provider=provider)

    @backend.get("/__trace_probe")
    async def probe():
        context = trace.get_current_span().get_span_context()
        return {
            "trace_id": f"{context.trace_id:032x}",
            "span_id": f"{context.span_id:016x}",
            "request_id": get_request_id(),
        }

    async with traced_async_client(
        base_url="http://backend",
        transport=httpx.ASGITransport(app=backend),
        event_hooks=internal_http_event_hooks(),
        headers={"X-Service-Name": "chat-shell"},
    ) as internal:
        HTTPXClientInstrumentor.instrument_client(internal, tracer_provider=provider)

        @chat_shell.get("/__trace_forward")
        async def forward():
            context = trace.get_current_span().get_span_context()
            response = await internal.get("/__trace_probe")
            return {
                "local_trace": f"{context.trace_id:032x}",
                "local_span": f"{context.span_id:016x}",
                "backend": response.json(),
                "backend_header": response.headers.get("X-Request-ID"),
            }

        async with httpx.AsyncClient(
            base_url="http://chat-shell", transport=httpx.ASGITransport(app=chat_shell)
        ) as client:
            response = await client.get(
                "/__trace_forward",
                headers={
                    "X-Request-ID": "req-412317010590",
                    "traceparent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
                },
            )
    assert response.status_code == 200
    expected_trace = "1234567890abcdef1234567890abcdef"
    body = response.json()
    assert response.headers["X-Request-ID"] == "req-412317010590"
    assert body["backend_header"] == "req-412317010590"
    assert body["local_trace"] == expected_trace
    assert body["backend"]["trace_id"] == expected_trace
    assert body["backend"]["request_id"] == "req-412317010590"
    assert body["local_span"] != "1234567890abcdef"
    assert body["backend"]["span_id"] != body["local_span"]
    spans = exporter.get_finished_spans()
    backend_span = next(
        s for s in spans if f"{s.context.span_id:016x}" == body["backend"]["span_id"]
    )
    client_span = next(
        s for s in spans if s.context.span_id == backend_span.parent.span_id
    )
    assert f"{client_span.parent.span_id:016x}" == body["local_span"]
    provider.shutdown()
