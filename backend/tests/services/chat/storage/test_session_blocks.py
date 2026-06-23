# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for streaming block storage behavior."""

import json

import pytest

from app.services.chat.storage.session import SessionManager


class FakeRedisClient:
    def __init__(self):
        self.lists = {}
        self.values = {}
        self.expirations = {}
        self.lset_calls = []
        self.pipeline_execute_count = 0

    async def get(self, key):
        return self.values.get(key)

    async def mget(self, keys):
        return [self.values.get(key) for key in keys]

    async def set(self, key, value, ex=None):
        self.values[key] = value
        if ex is not None:
            self.expirations[key] = ex
        return True

    async def append(self, key, value):
        self.values[key] = self.values.get(key, "") + value
        return len(self.values[key])

    async def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)
            self.lists.pop(key, None)
        return len(keys)

    async def rpush(self, key, value):
        self.lists.setdefault(key, []).append(value)
        return len(self.lists[key])

    async def lrange(self, key, start, end):
        values = self.lists.get(key, [])
        if end == -1:
            return values[start:]
        return values[start : end + 1]

    async def lset(self, key, index, value):
        self.lset_calls.append((key, index, value))
        self.lists[key][index] = value
        return True

    async def expire(self, key, ttl):
        self.expirations[key] = ttl
        return True

    def pipeline(self, transaction=True):
        return FakePipeline(self)

    async def aclose(self):
        return None


class FakePipeline:
    def __init__(self, redis_client):
        self.redis_client = redis_client
        self.commands = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    def append(self, key, value):
        self.commands.append(("append", key, value))
        return self

    def expire(self, key, ttl):
        self.commands.append(("expire", key, ttl))
        return self

    def rpush(self, key, value):
        self.commands.append(("rpush", key, value))
        return self

    def set(self, key, value, ex=None):
        self.commands.append(("set", key, value, ex))
        return self

    def lset(self, key, index, value):
        self.commands.append(("lset", key, index, value))
        return self

    def delete(self, *keys):
        self.commands.append(("delete", *keys))
        return self

    async def execute(self):
        self.redis_client.pipeline_execute_count += 1
        results = []
        for command in self.commands:
            name = command[0]
            if name == "append":
                results.append(await self.redis_client.append(command[1], command[2]))
            elif name == "expire":
                results.append(await self.redis_client.expire(command[1], command[2]))
            elif name == "rpush":
                results.append(await self.redis_client.rpush(command[1], command[2]))
            elif name == "set":
                results.append(
                    await self.redis_client.set(command[1], command[2], ex=command[3])
                )
            elif name == "lset":
                results.append(
                    await self.redis_client.lset(command[1], command[2], command[3])
                )
            elif name == "delete":
                results.append(await self.redis_client.delete(*command[1:]))
        self.commands = []
        return results


class FakeCache:
    def __init__(self, redis_client):
        self.redis_client = redis_client

    async def _get_client(self):
        return self.redis_client


@pytest.mark.asyncio
async def test_add_tool_block_is_idempotent_by_tool_use_id():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(
        subtask_id=202,
        tool_use_id="Bash_1",
        tool_name="Bash",
        tool_input={"command": "pwd"},
        tool_protocol="function_call",
    )
    await manager.add_tool_block(
        subtask_id=202,
        tool_use_id="Bash_1",
        tool_name="Bash",
        tool_input={"command": "pwd"},
        tool_protocol="function_call",
    )

    blocks = await manager.get_blocks(202)

    assert len(blocks) == 1
    assert blocks[0]["tool_use_id"] == "Bash_1"
    assert blocks[0]["tool_name"] == "Bash"
    assert blocks[0]["tool_input"] == {"command": "pwd"}
    assert blocks[0]["tool_protocol"] == "function_call"
    assert json.loads(redis_client.lists["chat:streaming:blocks:202"][0]) == blocks[0]


@pytest.mark.asyncio
async def test_thinking_blocks_are_split_by_text_boundaries():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_thinking_content(subtask_id=303, content="First ")
    await manager.add_thinking_content(subtask_id=303, content="thought.")
    await manager.add_text_content(subtask_id=303, content="Answer.")
    await manager.add_thinking_content(subtask_id=303, content="Second thought.")

    blocks = await manager.finalize_and_get_blocks(303)

    assert [block["type"] for block in blocks] == ["thinking", "text", "thinking"]
    assert blocks[0]["content"] == "First thought."
    assert blocks[1]["content"] == "Answer."
    assert blocks[2]["content"] == "Second thought."
    assert [block["status"] for block in blocks] == ["done", "done", "done"]
    assert blocks[0]["timestamp"] > 1_000_000_000_000
    assert blocks[2]["timestamp"] > 1_000_000_000_000


@pytest.mark.asyncio
async def test_add_block_fills_wall_clock_epoch_timestamp():
    """Blocks without a timestamp must get a valid epoch-ms value.

    Regression: the fallback previously used the event loop's monotonic clock,
    producing a small non-epoch number that clients reject as invalid, which
    collapsed the rendered turn duration to 0s after a refresh.
    """
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_block(
        subtask_id=404,
        block={"type": "tool", "tool_name": "Bash"},
    )

    blocks = await manager.get_blocks(404)

    assert len(blocks) == 1
    # A real wall-clock epoch in milliseconds is always greater than 1e12.
    assert blocks[0]["timestamp"] > 1_000_000_000_000
    # An auto-generated id must also be derived from wall-clock time.
    assert blocks[0]["id"].startswith("block-")
    assert int(blocks[0]["id"].removeprefix("block-")) > 1_000_000_000_000


@pytest.mark.asyncio
async def test_text_chunks_use_block_content_key_and_pipeline():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)
    await manager.add_text_content(subtask_id=505, content="Hel")
    await manager.add_text_content(subtask_id=505, content="lo")

    raw_block = json.loads(redis_client.lists["chat:streaming:blocks:505"][0])
    content_key = raw_block["_content_key"]

    assert raw_block["content"] == ""
    assert redis_client.values[content_key] == "Hello"
    assert redis_client.values["chat:streaming:505"] == "Hello"
    assert redis_client.pipeline_execute_count >= 2
    assert redis_client.lset_calls == []

    blocks = await manager.get_blocks(505)

    assert blocks[0]["content"] == "Hello"
    assert "_content_key" not in blocks[0]

    await manager.cleanup_streaming_state(505)

    assert content_key not in redis_client.values


@pytest.mark.asyncio
async def test_add_block_preserves_existing_block_content_key():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_text_content(subtask_id=606, content="old")
    blocks = await manager.get_blocks(606)
    content_key = json.loads(redis_client.lists["chat:streaming:blocks:606"][0])[
        "_content_key"
    ]

    blocks[0]["content"] = "updated"
    await manager.add_block(subtask_id=606, block=blocks[0])

    raw_block = json.loads(redis_client.lists["chat:streaming:blocks:606"][0])
    updated_blocks = await manager.get_blocks(606)

    assert raw_block["_content_key"] == content_key
    assert raw_block["content"] == ""
    assert redis_client.values[content_key] == "updated"
    assert updated_blocks[0]["content"] == "updated"


@pytest.mark.asyncio
async def test_finalize_and_get_blocks_marks_unresolved_preview_tool_blocks_error():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(
        subtask_id=505,
        tool_use_id="read_file_1",
        tool_name="read_file",
        tool_input={"file_path": "/tmp/a.txt"},
    )
    await manager.update_tool_block_status(
        subtask_id=505,
        tool_use_id="read_file_1",
        status="pending",
        tool_input={"file_path": "/tmp/a.txt"},
    )

    blocks = await manager.finalize_and_get_blocks(
        505,
        termination_reason="completed_with_unexecuted_tool_calls",
    )

    assert blocks == [
        {
            "id": "read_file_1",
            "type": "tool",
            "tool_use_id": "read_file_1",
            "tool_name": "read_file",
            "tool_input": {"file_path": "/tmp/a.txt"},
            "status": "error",
            "timestamp": blocks[0]["timestamp"],
            "tool_output": "Tool call was not executed before the turn completed. The turn may have hit the tool-call limit.",
        }
    ]


@pytest.mark.asyncio
async def test_finalize_and_get_blocks_uses_generic_message_without_limit_reason():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(
        subtask_id=506,
        tool_use_id="read_file_2",
        tool_name="read_file",
        tool_input={"file_path": "/tmp/b.txt"},
    )
    await manager.update_tool_block_status(
        subtask_id=506,
        tool_use_id="read_file_2",
        status="pending",
        tool_input={"file_path": "/tmp/b.txt"},
    )

    blocks = await manager.finalize_and_get_blocks(506)

    assert blocks[0]["status"] == "error"
    assert (
        blocks[0]["tool_output"]
        == "Tool call preview did not complete before the turn ended."
    )


@pytest.mark.asyncio
async def test_finalize_and_get_blocks_uses_generic_message_when_explicit_tool_error_exists():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(
        subtask_id=507,
        tool_use_id="preview_1",
        tool_name="exec",
        tool_input={"command": "ls"},
    )
    await manager.update_tool_block_status(
        subtask_id=507,
        tool_use_id="preview_1",
        status="pending",
        tool_input={"command": "ls"},
    )
    await manager.add_tool_block(
        subtask_id=507,
        tool_use_id="exec_real_1",
        tool_name="exec",
        tool_input={"command": "ls"},
    )
    await manager.update_tool_block_status(
        subtask_id=507,
        tool_use_id="exec_real_1",
        status="error",
        tool_input={"command": "ls"},
        tool_output="command: Field required",
    )

    blocks = await manager.finalize_and_get_blocks(
        507,
        termination_reason="completed_with_unexecuted_tool_calls",
    )

    preview_block = next(
        block for block in blocks if block["tool_use_id"] == "preview_1"
    )
    real_error_block = next(
        block for block in blocks if block["tool_use_id"] == "exec_real_1"
    )

    assert preview_block["status"] == "error"
    assert (
        preview_block["tool_output"]
        == "Tool call preview did not complete before the turn ended."
    )
    assert real_error_block["tool_output"] == "command: Field required"


@pytest.mark.asyncio
async def test_finalize_and_get_blocks_preserves_legitimate_pending_tool_blocks():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(
        subtask_id=606,
        tool_use_id="interactive_1",
        tool_name="interactive_form_question",
        tool_input={"questions": [{"id": "genre"}]},
    )
    await manager.update_tool_block_status(
        subtask_id=606,
        tool_use_id="interactive_1",
        status="pending",
        tool_input={"questions": [{"id": "genre"}]},
        tool_output={"status": "waiting_for_user_response"},
    )

    blocks = await manager.finalize_and_get_blocks(606)

    assert blocks == [
        {
            "id": "interactive_1",
            "type": "tool",
            "tool_use_id": "interactive_1",
            "tool_name": "interactive_form_question",
            "tool_input": {"questions": [{"id": "genre"}]},
            "status": "pending",
            "timestamp": blocks[0]["timestamp"],
            "tool_output": {"status": "waiting_for_user_response"},
        }
    ]
