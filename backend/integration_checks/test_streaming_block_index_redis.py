# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the streaming block index against CI's existing disposable Redis."""

import json
import os
import uuid
from pathlib import Path
from urllib.parse import urlparse

import pytest
import pytest_asyncio
from redis.asyncio import Redis

from app.services.chat.storage.session import SessionManager


@pytest_asyncio.fixture
async def storage():
    url = os.environ["PLUGIN_AUTH_REDIS_TEST_URL"]
    assert urlparse(url).hostname in {"localhost", "127.0.0.1", "::1"}
    subtask_id = uuid.uuid4().int % (1 << 52)

    class Cache:
        async def _get_client(self):
            return Redis.from_url(url, decode_responses=False)

    manager = SessionManager()
    manager._cache = Cache()
    client = Redis.from_url(url, decode_responses=False)
    try:
        yield manager, client, subtask_id
    finally:
        await manager.cleanup_streaming_state(subtask_id)
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("block_id", ["_watermark", "_watermark_id", "block:a", "a"])
async def test_reserved_ids_update_one_existing_block(storage, block_id):
    manager, client, subtask_id = storage
    for candidate in (block_id, "other_a", "other_b"):
        await manager.add_block(
            subtask_id, {"id": candidate, "type": "tool", "tool_output": "original"}
        )

    existing = await manager.get_block(subtask_id, block_id)
    assert existing is not None
    existing["tool_output"] = "updated"
    await manager.add_block(subtask_id, existing)

    blocks = await manager.get_blocks(subtask_id)
    assert [block["id"] for block in blocks] == [block_id, "other_a", "other_b"]
    assert blocks[0]["tool_output"] == "updated"
    index_key = manager._get_blocks_index_key(subtask_id)
    assert await client.hget(index_key, f"block:{block_id}") == b"0"
    assert 0 < await client.ttl(index_key) <= 3600


@pytest.mark.asyncio
async def test_rust_format_and_unindexed_suffix_are_updated_without_duplicates(storage):
    manager, client, subtask_id = storage
    blocks_key = manager._get_blocks_key(subtask_id)
    index_key = manager._get_blocks_index_key(subtask_id)
    await client.rpush(blocks_key, json.dumps({"id": "rust", "type": "tool"}))
    await client.hset(
        index_key, mapping={"block:rust": 0, "_watermark": 1, "_watermark_id": "rust"}
    )
    assert (await manager.get_block(subtask_id, "rust"))["id"] == "rust"
    for offset in range(20):
        await client.rpush(
            blocks_key,
            json.dumps({"id": f"legacy-{offset}", "type": "tool"}),
        )

    block = await manager.get_block(subtask_id, "legacy-0")
    assert block is not None
    block["status"] = "done"
    await manager.add_block(subtask_id, block)
    assert len(await manager.get_blocks(subtask_id)) == 21
    assert (await manager.get_block(subtask_id, "legacy-0"))["status"] == "done"

    await client.pexpireat(index_key, 1)
    assert (await manager.get_block(subtask_id, "legacy-0"))["status"] == "done"
    await manager.cleanup_streaming_state(subtask_id)
    assert await client.exists(index_key, blocks_key) == 0


@pytest.mark.asyncio
async def test_python_and_rust_lua_can_read_each_others_index(storage):
    manager, client, subtask_id = storage
    script_path = (
        Path(__file__).resolve().parents[2]
        / "backend-rs/execution-runtime/src/block_index.lua"
    )
    script = (
        script_path.read_text()
        + """
local index, raw = find_block(KEYS[1], KEYS[2], ARGV[1], ARGV[2])
if index then return {tostring(index), raw} end
return {}
"""
    )
    for block_id in ("_watermark_id", "a", "b"):
        await manager.add_block(
            subtask_id, {"id": block_id, "type": "tool", "tool_output": "original"}
        )
    keys = [
        manager._get_blocks_key(subtask_id),
        manager._get_blocks_index_key(subtask_id),
    ]
    await client.delete(keys[1])
    position, raw = await client.eval(script, 2, *keys, "_watermark_id", 3600)
    assert position == b"0"
    assert json.loads(raw)["tool_output"] == "original"
    existing = await manager.get_block(subtask_id, "_watermark_id")
    assert existing is not None
    existing["tool_output"] = "updated-by-python"
    await manager.add_block(subtask_id, existing)
    position, raw = await client.eval(script, 2, *keys, "_watermark_id", 3600)
    assert position == b"0"
    assert json.loads(raw)["tool_output"] == "updated-by-python"
    assert await client.llen(keys[0]) == 3
