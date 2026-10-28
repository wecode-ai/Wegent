# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for streaming block storage behavior."""

import json

import pytest

from app.services.chat.storage import session as session_module
from app.services.chat.storage.session import SessionManager
from shared.models.blocks import create_text_block


class FakeRedisClient:
    def __init__(self):
        self.lists = {}
        self.values = {}
        self.hashes = {}
        self.expirations = {}
        self.lset_calls = []
        self.full_lrange_calls = []
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
            self.hashes.pop(key, None)
        return len(keys)

    async def exists(self, key):
        return int(key in self.values or key in self.lists or key in self.hashes)

    async def rpush(self, key, value):
        self.lists.setdefault(key, []).append(value)
        return len(self.lists[key])

    async def llen(self, key):
        return len(self.lists.get(key, []))

    async def lindex(self, key, index):
        values = self.lists.get(key, [])
        if -len(values) <= index < len(values):
            return values[index]
        return None

    async def lrange(self, key, start, end):
        values = self.lists.get(key, [])
        if start == 0 and end == -1:
            self.full_lrange_calls.append(key)
        if end == -1:
            return values[start:]
        return values[start : end + 1]

    async def hset(self, key, field=None, value=None, mapping=None):
        fields = dict(mapping or {})
        if field is not None:
            fields[field] = value
        # Redis returns hash values as bytes with decode_responses=False.
        self.hashes.setdefault(key, {}).update(
            {name: str(item).encode() for name, item in fields.items()}
        )
        return len(fields)

    async def hget(self, key, field):
        return self.hashes.get(key, {}).get(field)

    async def hdel(self, key, *fields):
        hash_value = self.hashes.get(key, {})
        removed = sum(1 for field in fields if hash_value.pop(field, None) is not None)
        if key in self.hashes and not hash_value:
            del self.hashes[key]
        return removed

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

    def hset(self, key, field=None, value=None, mapping=None):
        self.commands.append(("hset", key, field, value, mapping))
        return self

    def hdel(self, key, *fields):
        self.commands.append(("hdel", key, *fields))
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
            elif name == "hset":
                results.append(
                    await self.redis_client.hset(
                        command[1], command[2], command[3], mapping=command[4]
                    )
                )
            elif name == "hdel":
                results.append(await self.redis_client.hdel(command[1], *command[2:]))
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
async def test_add_block_appends_content_delta_to_inline_block_content():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_block(
        subtask_id=707,
        block={
            "id": "text-1",
            "type": "text",
            "content": "part1",
            "status": "streaming",
        },
    )
    await manager.add_block(
        subtask_id=707,
        block={
            "id": "text-1",
            "type": "text",
            "content": "part1",
            "content_delta": "part2",
        },
    )

    blocks = await manager.get_blocks(707)
    assert blocks[0]["content"] == "part1part2"
    assert "content_delta" not in blocks[0]


@pytest.mark.asyncio
async def test_add_block_appends_content_delta_to_dedicated_content_key():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_text_content(subtask_id=808, content="old")
    blocks = await manager.get_blocks(808)
    content_key = json.loads(redis_client.lists["chat:streaming:blocks:808"][0])[
        "_content_key"
    ]

    blocks[0]["content_delta"] = "delta"
    await manager.add_block(subtask_id=808, block=blocks[0])

    raw_block = json.loads(redis_client.lists["chat:streaming:blocks:808"][0])
    updated_blocks = await manager.get_blocks(808)

    assert raw_block["_content_key"] == content_key
    assert redis_client.values[content_key] == "olddelta"
    assert updated_blocks[0]["content"] == "olddelta"


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
async def test_finalize_and_get_blocks_closes_preview_blocks_on_successful_terminal():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(
        subtask_id=508,
        tool_use_id="write_1",
        tool_name="Write",
        tool_input={"file_path": "/tmp/evals.json"},
    )
    await manager.update_tool_block_status(
        subtask_id=508,
        tool_use_id="write_1",
        status="pending",
        tool_input={"file_path": "/tmp/evals.json"},
    )

    blocks = await manager.finalize_and_get_blocks(
        508,
        terminal_status="COMPLETED",
    )

    assert blocks[0]["status"] == "done"
    assert "tool_output" not in blocks[0]


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


@pytest.mark.asyncio
async def test_block_upserts_do_not_reload_the_whole_list(monkeypatch):
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)
    # Text block ids are millisecond timestamps; keep them distinct in a tight loop.
    text_ids = iter(range(1_000_000))
    monkeypatch.setattr(
        session_module,
        "create_text_block",
        lambda content="": create_text_block(
            content=content, block_id=f"text-{next(text_ids)}"
        ),
    )

    await manager.add_text_content(subtask_id=901, content="intro")
    for i in range(200):
        await manager.add_tool_block(
            subtask_id=901,
            tool_use_id=f"call_{i}",
            tool_name="Bash",
            tool_input={"command": f"echo {i}"},
        )
        await manager.update_tool_block_status(
            subtask_id=901,
            tool_use_id=f"call_{i}",
            status="generating_arguments",
        )
        await manager.update_tool_block_status(
            subtask_id=901,
            tool_use_id=f"call_{i}",
            status="done",
            tool_output=f"out {i}",
        )
        await manager.add_thinking_content(subtask_id=901, content=f"step {i}")
        await manager.add_text_content(subtask_id=901, content=f"text {i}")

    # Every lookup goes through the blocks index or the list tail.
    assert redis_client.full_lrange_calls == []

    blocks = await manager.finalize_and_get_blocks(901)
    tool_blocks = [block for block in blocks if block["type"] == "tool"]

    assert len(blocks) == 1 + 200 * 3
    assert len(tool_blocks) == 200
    assert all(block["status"] == "done" for block in blocks)
    assert tool_blocks[150]["tool_output"] == "out 150"
    assert blocks[-1]["content"] == "text 199"


@pytest.mark.asyncio
async def test_blocks_index_is_rebuilt_for_a_list_written_without_it():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)
    blocks_key = "chat:streaming:blocks:902"
    redis_client.lists[blocks_key] = [
        json.dumps({"id": "call_a", "type": "tool", "tool_use_id": "call_a"}),
        json.dumps({"id": "call_b", "type": "tool", "tool_use_id": "call_b"}),
    ]

    await manager.update_tool_block_status(
        subtask_id=902, tool_use_id="call_b", status="done", tool_output="ok"
    )
    await manager.add_tool_block(subtask_id=902, tool_use_id="call_a", tool_name="Read")

    blocks = await manager.get_blocks(902)

    assert [block["id"] for block in blocks] == ["call_a", "call_b"]
    assert blocks[0]["tool_name"] == "Read"
    assert blocks[1]["status"] == "done"
    assert blocks[1]["tool_output"] == "ok"
    assert redis_client.hashes["chat:streaming:blocks_index:902"] == {
        "call_a": b"0",
        "call_b": b"1",
    }


@pytest.mark.asyncio
async def test_stale_blocks_index_entry_is_repaired():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(subtask_id=903, tool_use_id="call_a", tool_name="A")
    await manager.add_tool_block(subtask_id=903, tool_use_id="call_b", tool_name="B")
    # Point call_b at the wrong slot.
    redis_client.hashes["chat:streaming:blocks_index:903"]["call_b"] = b"0"

    await manager.update_tool_block_status(
        subtask_id=903, tool_use_id="call_b", status="done"
    )

    blocks = await manager.get_blocks(903)

    assert [block["status"] for block in blocks] == ["pending", "done"]
    assert redis_client.hashes["chat:streaming:blocks_index:903"]["call_b"] == b"1"


@pytest.mark.asyncio
async def test_block_appended_before_it_is_indexed_is_found_at_the_tail():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(subtask_id=904, tool_use_id="call_a", tool_name="A")
    # A concurrent writer has pushed call_b but not indexed it yet.
    redis_client.lists["chat:streaming:blocks:904"].append(
        json.dumps({"id": "call_b", "type": "tool", "tool_use_id": "call_b"})
    )
    redis_client.full_lrange_calls.clear()

    await manager.update_tool_block_status(
        subtask_id=904, tool_use_id="call_b", status="done"
    )

    blocks = await manager.get_blocks(904)

    assert len(blocks) == 2
    assert blocks[1]["status"] == "done"
    assert redis_client.full_lrange_calls == ["chat:streaming:blocks:904"]
    assert redis_client.hashes["chat:streaming:blocks_index:904"]["call_b"] == b"1"


@pytest.mark.asyncio
async def test_get_block_returns_one_block_with_its_content():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_text_content(subtask_id=905, content="Hello")
    await manager.add_tool_block(subtask_id=905, tool_use_id="call_a", tool_name="A")
    text_id = json.loads(redis_client.lists["chat:streaming:blocks:905"][0])["id"]

    text_block = await manager.get_block(905, text_id)

    assert text_block["content"] == "Hello"
    assert text_block["status"] == "done"
    assert "_content_key" not in text_block
    assert (await manager.get_block(905, "call_a"))["tool_name"] == "A"
    assert await manager.get_block(905, "missing") is None


@pytest.mark.asyncio
async def test_tool_block_with_a_different_block_id_is_still_updated():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_block(
        subtask_id=906,
        block={"id": "block_1", "type": "tool", "tool_use_id": "call_x"},
    )

    await manager.update_tool_block_status(
        subtask_id=906, tool_use_id="call_x", status="done"
    )

    blocks = await manager.get_blocks(906)

    assert len(blocks) == 1
    assert blocks[0]["status"] == "done"


@pytest.mark.asyncio
async def test_cleanup_streaming_state_deletes_blocks_index():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(subtask_id=907, tool_use_id="call_a", tool_name="A")
    assert "chat:streaming:blocks_index:907" in redis_client.hashes

    await manager.cleanup_streaming_state(907)

    assert "chat:streaming:blocks_index:907" not in redis_client.hashes
    assert "chat:streaming:blocks:907" not in redis_client.lists


@pytest.mark.asyncio
async def test_block_whose_position_write_failed_is_not_duplicated():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(subtask_id=908, tool_use_id="call_x", tool_name="X")

    async def lose_the_position(*args):
        raise ConnectionError("Redis went away")

    # The connection drops right after call_a is pushed.
    manager._index_block = lose_the_position
    await manager.add_tool_block(subtask_id=908, tool_use_id="call_a", tool_name="A")
    del manager._index_block
    # Move call_a out of the tail that lookups scan.
    for i in range(session_module.BLOCKS_INDEX_TAIL_SCAN + 2):
        await manager.add_tool_block(
            subtask_id=908, tool_use_id=f"call_{i}", tool_name="B"
        )
    redis_client.full_lrange_calls.clear()

    await manager.update_tool_block_status(
        subtask_id=908, tool_use_id="call_a", status="done"
    )

    assert redis_client.full_lrange_calls == ["chat:streaming:blocks:908"]
    blocks = await manager.get_blocks(908)
    assert len(blocks) == 12
    assert [block["status"] for block in blocks[:2]] == ["pending", "done"]
    assert redis_client.hashes["chat:streaming:blocks_index:908"]["call_a"] == b"1"


@pytest.mark.asyncio
async def test_pending_blocks_index_entry_without_a_block_is_dropped():
    manager = SessionManager()
    redis_client = FakeRedisClient()
    manager._cache = FakeCache(redis_client)

    await manager.add_tool_block(subtask_id=909, tool_use_id="call_a", tool_name="A")
    # An append marked "ghost" pending, then never reached the list.
    redis_client.hashes["chat:streaming:blocks_index:909"]["ghost"] = b"pending"

    assert await manager.get_block(909, "ghost") is None
    assert redis_client.hashes["chat:streaming:blocks_index:909"] == {"call_a": b"0"}
