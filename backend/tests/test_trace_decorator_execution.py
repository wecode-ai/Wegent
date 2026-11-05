"""Tracing must never retry business code or repeat streamed output."""

from collections.abc import AsyncIterator
from unittest.mock import Mock

import pytest
from opentelemetry.sdk.trace import TracerProvider

from shared.telemetry import decorators


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("error_type", [ImportError, ValueError])
@pytest.mark.parametrize("mode", ["sync", "async", "background", "generator"])
async def test_tracing_propagates_business_errors_after_one_execution(
    monkeypatch: pytest.MonkeyPatch,
    enabled: bool,
    error_type: type[Exception],
    mode: str,
) -> None:
    provider = TracerProvider()
    monkeypatch.setattr(decorators, "_is_telemetry_enabled", lambda: enabled)
    monkeypatch.setattr(decorators, "_get_tracer", provider.get_tracer)
    failure = error_type("business failure")
    invocation = Mock(side_effect=failure)
    output: list[str] = []

    def operation() -> None:
        invocation()

    @decorators.trace_async()
    async def async_operation() -> None:
        operation()

    @decorators.trace_async_generator()
    async def generator_operation() -> AsyncIterator[str]:
        yield "first result"
        operation()

    try:
        with pytest.raises(error_type) as raised:
            if mode == "sync":
                decorators.trace_sync()(operation)()
            elif mode == "background":
                decorators.trace_background()(operation)()
            elif mode == "async":
                await async_operation()
            else:
                async for value in generator_operation():
                    output.append(value)
        assert raised.value is failure
        invocation.assert_called_once_with()
        assert output == (["first result"] if mode == "generator" else [])
    finally:
        provider.shutdown()
