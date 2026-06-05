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

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, ex=None):
        self.values[key] = value
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
        self.lists[key][index] = value
        return True

    async def expire(self, key, ttl):
        return True

    async def aclose(self):
        return None


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
