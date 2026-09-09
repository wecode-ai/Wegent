# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from shared.telemetry import decorators


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["disabled", "no_tracer", "enabled"])
async def test_traced_generator_closes_underlying_resource_on_disconnect(
    monkeypatch, mode
):
    monkeypatch.setattr(decorators, "_is_telemetry_enabled", lambda: mode != "disabled")
    monkeypatch.setattr(
        decorators,
        "_get_tracer",
        lambda _: None if mode == "no_tracer" else MagicMock(),
    )
    closed = []

    @decorators.trace_async_generator("test.stream")
    async def source():
        try:
            yield "first"
            yield "second"
        finally:
            closed.append(True)

    stream = source()
    assert await anext(stream) == "first"
    await stream.aclose()
    assert closed == [True]
