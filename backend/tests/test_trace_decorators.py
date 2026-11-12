# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tracing must not retry business operations when their imports fail."""

import builtins
from typing import Any, AsyncIterator, Callable, Iterator
from unittest.mock import Mock

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from shared.telemetry import decorators

KINDS = ["async", "sync", "background", "async_generator"]


@pytest.fixture
def traced_spans(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer(__name__)
    monkeypatch.setattr(decorators, "_is_telemetry_enabled", lambda: True)
    monkeypatch.setattr(decorators, "_get_tracer", lambda _: tracer)
    yield exporter
    provider.shutdown()


def make_operation(kind: str, business: Mock) -> Callable[[], Any]:
    if kind == "async":

        async def operation() -> Any:
            return business()

    elif kind == "async_generator":

        async def operation() -> AsyncIterator[str]:
            yield "prefix"
            yield business()

    else:

        def operation() -> Any:
            return business()

    decorate = getattr(decorators, f"trace_{kind}")
    return decorate("test.operation")(operation)


async def invoke_operation(
    kind: str, operation: Callable[[], Any], yielded: list[str]
) -> Any:
    if kind == "async_generator":
        async for item in operation():
            yielded.append(item)
        return yielded[-1]
    if kind == "async":
        return await operation()
    return operation()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("error_type", [ImportError, ValueError])
async def test_business_error_is_recorded_and_propagated_without_retry(
    traced_spans: InMemorySpanExporter, kind: str, error_type: type[Exception]
) -> None:
    failure = error_type("business failure")
    business = Mock(side_effect=failure)
    operation = make_operation(kind, business)
    yielded: list[str] = []

    with pytest.raises(error_type) as captured:
        await invoke_operation(kind, operation, yielded)

    assert captured.value is failure
    business.assert_called_once_with()
    assert yielded == (["prefix"] if kind == "async_generator" else [])
    spans = traced_spans.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code == StatusCode.ERROR
    description = (
        "business failure"
        if kind == "background"
        else f"{error_type.__name__}: business failure"
    )
    assert spans[0].status.description == description
    assert any(
        event.name == "exception"
        and event.attributes["exception.type"] == error_type.__name__
        and event.attributes["exception.message"] == "business failure"
        for event in spans[0].events
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("fails", [False, True])
async def test_missing_telemetry_dependency_executes_business_once(
    monkeypatch: pytest.MonkeyPatch,
    traced_spans: InMemorySpanExporter,
    kind: str,
    fails: bool,
) -> None:
    failure = ImportError("business dependency unavailable")
    business = Mock(side_effect=failure) if fails else Mock(return_value="result")
    operation = make_operation(kind, business)
    yielded: list[str] = []
    original_import = builtins.__import__

    def missing_telemetry(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "opentelemetry":
            raise ModuleNotFoundError("OpenTelemetry unavailable")
        return original_import(name, *args, **kwargs)

    with monkeypatch.context() as imports:
        imports.setattr(builtins, "__import__", missing_telemetry)
        if fails:
            with pytest.raises(ImportError) as captured:
                await invoke_operation(kind, operation, yielded)
            assert captured.value is failure
        else:
            assert await invoke_operation(kind, operation, yielded) == "result"

    business.assert_called_once_with()
    assert traced_spans.get_finished_spans() == ()
    expected = ["prefix"] + ([] if fails else ["result"])
    assert yielded == (expected if kind == "async_generator" else [])
