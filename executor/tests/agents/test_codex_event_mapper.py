#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from executor.agents.codex.event_mapper import CodeXEventMapper
from shared.status import TaskStatus


def assert_commentary_block(
    emitter: SimpleNamespace,
    content: str,
    status: str = "done",
) -> dict:
    emitter.block_created.assert_awaited_once()
    block = emitter.block_created.await_args.args[0]
    assert block["id"].startswith("codex-commentary-")
    assert block["type"] == "thinking"
    assert block["content"] == content
    assert block["status"] == status
    assert isinstance(block["timestamp"], int)
    return block


@pytest.mark.asyncio
async def test_codex_event_mapper_streams_final_answer_delta_and_completion():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/agentMessage/delta",
            payload=SimpleNamespace(delta="Hello", phase="final_answer"),
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
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
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


@pytest.mark.asyncio
async def test_codex_event_mapper_routes_commentary_to_processing_block():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "type": "message",
                "role": "assistant",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "Working on it"}],
            },
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
    assert_commentary_block(emitter, "Working on it")
    emitter.block_updated.assert_not_awaited()
    emitter.reasoning.assert_not_awaited()
    emitter.text_delta.assert_not_awaited()
    emitter.done.assert_awaited_once_with(content="", usage=None)


@pytest.mark.asyncio
async def test_codex_event_mapper_routes_commentary_delta_without_duplicate_done():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/started",
            payload={
                "item": {
                    "root": {
                        "type": "agentMessage",
                        "id": "msg_1",
                        "phase": "commentary",
                        "text": "",
                    }
                }
            },
        )
    )
    await mapper.handle(
        SimpleNamespace(
            method="item/agentMessage/delta",
            payload=SimpleNamespace(delta="Working", item_id="msg_1"),
        )
    )
    block = assert_commentary_block(emitter, "", status="streaming")
    emitter.block_updated.assert_awaited_once_with(
        block["id"],
        {
            "content": "Working",
            "status": "streaming",
        },
    )
    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "type": "agentMessage",
                "id": "msg_1",
                "role": "assistant",
                "phase": "commentary",
                "text": "Working",
            },
        )
    )

    assert emitter.block_created.await_count == 1
    assert emitter.block_updated.await_count == 2
    emitter.block_updated.assert_awaited_with(
        block["id"],
        {
            "content": "Working",
            "status": "done",
        },
    )
    emitter.reasoning.assert_not_awaited()
    emitter.text_delta.assert_not_awaited()


@pytest.mark.asyncio
async def test_codex_event_mapper_buffers_unphased_delta_until_commentary_done():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/agentMessage/delta",
            payload=SimpleNamespace(delta="Working"),
        )
    )
    emitter.text_delta.assert_not_awaited()
    emitter.reasoning.assert_not_awaited()
    emitter.block_created.assert_not_awaited()

    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "type": "message",
                "role": "assistant",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "Working"}],
            },
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
    assert_commentary_block(emitter, "Working")
    emitter.reasoning.assert_not_awaited()
    emitter.text_delta.assert_not_awaited()
    emitter.done.assert_awaited_once_with(content="", usage=None)


@pytest.mark.asyncio
async def test_codex_event_mapper_buffers_unphased_delta_until_final_done():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/agentMessage/delta",
            payload=SimpleNamespace(delta="Final answer"),
        )
    )
    emitter.text_delta.assert_not_awaited()

    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "type": "message",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "Final answer"}],
            },
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
    emitter.text_delta.assert_awaited_once_with("Final answer")
    emitter.done.assert_awaited_once_with(content="Final answer", usage=None)


@pytest.mark.asyncio
async def test_codex_event_mapper_streams_final_answer_message():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "type": "message",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "Final answer"}],
            },
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
    emitter.text_delta.assert_awaited_once_with("Final answer")
    emitter.done.assert_awaited_once_with(content="Final answer", usage=None)


@pytest.mark.asyncio
async def test_codex_event_mapper_maps_exec_command_to_bash_tool_block():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "type": "function_call",
                "name": "exec_command",
                "arguments": (
                    '{"cmd":"pwd","workdir":"/tmp/project","max_output_tokens":2000}'
                ),
                "call_id": "call_1",
            },
        )
    )
    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "Chunk ID: x\nOutput:\n/tmp/project\n",
            },
        )
    )

    emitter.tool_start.assert_awaited_once_with(
        call_id="call_1",
        name="bash",
        arguments={
            "max_output_tokens": 2000,
            "command": "pwd",
            "cwd": "/tmp/project",
        },
        display_name="Shell",
        tool_protocol="function_call",
    )
    emitter.tool_done.assert_awaited_once_with(
        call_id="call_1",
        name="bash",
        arguments={
            "max_output_tokens": 2000,
            "command": "pwd",
            "cwd": "/tmp/project",
        },
        output="Chunk ID: x\nOutput:\n/tmp/project\n",
        tool_protocol="function_call",
    )


@pytest.mark.asyncio
async def test_codex_event_mapper_maps_command_execution_to_bash_tool_block():
    emitter = SimpleNamespace(
        text_delta=AsyncMock(),
        reasoning=AsyncMock(),
        block_created=AsyncMock(),
        block_updated=AsyncMock(),
        tool_start=AsyncMock(),
        tool_done=AsyncMock(),
        done=AsyncMock(),
        incomplete=AsyncMock(),
        error=AsyncMock(),
    )
    mapper = CodeXEventMapper(emitter)

    await mapper.handle(
        SimpleNamespace(
            method="item/started",
            payload={
                "item": {
                    "root": {
                        "type": "commandExecution",
                        "id": "cmd_1",
                        "command": "python3 analyze.py",
                        "cwd": "/tmp/project",
                        "status": "inProgress",
                    }
                }
            },
        )
    )
    await mapper.handle(
        SimpleNamespace(
            method="item/completed",
            payload={
                "item": {
                    "root": {
                        "type": "commandExecution",
                        "id": "cmd_1",
                        "command": "python3 analyze.py",
                        "cwd": "/tmp/project",
                        "status": "completed",
                        "aggregatedOutput": "ok\n",
                        "exitCode": 0,
                    }
                }
            },
        )
    )

    emitter.tool_start.assert_awaited_once_with(
        call_id="cmd_1",
        name="bash",
        arguments={
            "command": "python3 analyze.py",
            "cwd": "/tmp/project",
        },
        display_name="Shell",
        tool_protocol="function_call",
    )
    emitter.tool_done.assert_awaited_once_with(
        call_id="cmd_1",
        name="bash",
        arguments={
            "command": "python3 analyze.py",
            "cwd": "/tmp/project",
        },
        output="ok\n",
        tool_protocol="function_call",
        status="completed",
    )
