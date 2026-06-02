#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from executor.agents.codex.event_mapper import CodeXEventMapper
from shared.status import TaskStatus


@pytest.mark.asyncio
async def test_codex_event_mapper_streams_delta_and_completion():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/agentMessage/delta",
            payload=SimpleNamespace(delta="Hello"),
        )
    )
    status = await mapper.handle(
        SimpleNamespace(
            method="turn/completed",
            payload=SimpleNamespace(
                turn=SimpleNamespace(status=SimpleNamespace(value="completed"))
            ),
        )
    )

    assert status == TaskStatus.COMPLETED
    emitter.text_delta.assert_awaited_once_with("Hello")
    emitter.done.assert_awaited_once_with(content="Hello", usage=None)


@pytest.mark.asyncio
async def test_codex_event_mapper_reports_interrupted_turn():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    status = await mapper.handle(
        SimpleNamespace(
            method="turn/completed",
            payload=SimpleNamespace(
                turn=SimpleNamespace(status=SimpleNamespace(value="interrupted"))
            ),
        )
    )

    assert status == TaskStatus.CANCELLED
    emitter.incomplete.assert_awaited_once_with(reason="cancelled", content="")
