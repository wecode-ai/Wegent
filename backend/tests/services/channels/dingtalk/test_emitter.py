# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for compact DingTalk AI Card progress."""

from unittest.mock import AsyncMock

import dingtalk_stream
import pytest

from app.services.channels.dingtalk import emitter as emitter_module
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from shared.models import EventType, ExecutionEvent


class FakeCard:
    def __init__(self, _client, _message):
        self.card_instance_id = None
        self.order = []
        self.updates: list[str] = []
        self.finished: list[str] = []
        self.failed = False

    def set_order(self, order):
        self.order = order

    def ai_start(self):
        self.card_instance_id = "card-1"

    def ai_streaming(self, content, append=False):
        assert append is False
        self.updates.append(content)

    def ai_finish(self, content):
        self.finished.append(content)

    def ai_fail(self):
        self.failed = True


class FakeRedis:
    def __init__(self, cache):
        self.cache = cache

    async def append(self, key, value):
        self.cache.raw[key] = self.cache.raw.get(key, b"") + value

    async def expire(self, _key, _ttl):
        return True

    async def get(self, key):
        return self.cache.raw.get(key)

    async def set(self, key, value, nx=False, px=None):
        if nx and key in self.cache.raw:
            return None
        self.cache.raw[key] = value
        return True

    async def delete(self, *keys):
        deleted = 0
        for key in keys:
            deleted += int(key in self.cache.raw or key in self.cache.structured)
            self.cache.raw.pop(key, None)
            self.cache.structured.pop(key, None)
        return deleted

    async def aclose(self):
        return None


class FakeCache:
    def __init__(self):
        self.raw: dict[str, bytes] = {}
        self.structured: dict[str, object] = {}

    async def _get_client(self):
        return FakeRedis(self)

    async def get(self, key):
        return self.structured.get(key)

    async def set(self, key, value, expire=None):
        self.structured[key] = value
        return True

    async def delete(self, key):
        self.raw.pop(key, None)
        return self.structured.pop(key, None) is not None


@pytest.fixture
def card_factory(monkeypatch: pytest.MonkeyPatch):
    cards: list[FakeCard] = []

    def create_card(client, message):
        card = FakeCard(client, message)
        cards.append(card)
        return card

    monkeypatch.setattr(dingtalk_stream, "AIMarkdownCardInstance", create_card)
    return cards


@pytest.fixture
def emitter(card_factory):
    result = StreamingResponseEmitter(object(), object())
    result.MIN_UPDATE_INTERVAL = 0
    return result


@pytest.mark.asyncio
async def test_start_and_thinking_render_safe_compact_status(emitter, card_factory):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit(
        ExecutionEvent.create(
            EventType.THINKING,
            task_id=1,
            subtask_id=2,
            content="private chain of thought that must not leave Wework",
        )
    )

    card = card_factory[0]
    assert "正在理解需求" in card.updates[0]
    assert "正在分析" in card.updates[-1]
    assert "private chain of thought" not in "".join(card.updates)


@pytest.mark.asyncio
async def test_dispatch_status_stays_in_progress_mode(emitter, card_factory):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit_status_prefix(
        task_id=1,
        subtask_id=2,
        content="任务已发送到设备 device-1\n\n状态: 正在执行",
    )
    await emitter.emit_thinking(task_id=1, subtask_id=2)

    card = card_factory[0]
    assert "任务已发送到设备 device-1 状态: 正在执行" in card.updates[-2]
    assert "正在分析" in card.updates[-1]
    assert emitter._progress.mode == "progress"


@pytest.mark.asyncio
async def test_progress_window_is_bounded_and_omits_tool_payloads(
    emitter, card_factory
):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit(
        ExecutionEvent.create(
            EventType.TOOL_START,
            task_id=1,
            subtask_id=2,
            tool_name="Read",
            tool_input={"path": "/secret/input"},
        )
    )
    await emitter.emit(
        ExecutionEvent.create(
            EventType.TOOL_RESULT,
            task_id=1,
            subtask_id=2,
            tool_name="Read",
            tool_output="secret tool output",
            data={"status": "completed"},
        )
    )
    for index in range(3):
        await emitter.emit(
            ExecutionEvent.create(
                EventType.BLOCK_CREATED,
                task_id=1,
                subtask_id=2,
                data={
                    "block": {
                        "id": f"commentary-{index}",
                        "type": "text",
                        "process_kind": "assistant_message",
                        "content": f"已完成过程步骤 {index}",
                        "status": "done",
                    }
                },
            )
        )

    rendered = card_factory[0].updates[-1]
    assert rendered.splitlines() == [
        "**执行进度**",
        "✅ 已完成过程步骤 1",
        "✅ 已完成过程步骤 2",
        "⏳ 继续处理…",
    ]
    assert len(rendered) <= 320
    all_updates = "".join(card_factory[0].updates)
    assert "/secret/input" not in all_updates
    assert "secret tool output" not in all_updates


@pytest.mark.asyncio
async def test_reasoning_block_is_generic_and_process_text_masks_secrets(
    emitter, card_factory
):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit(
        ExecutionEvent.create(
            EventType.BLOCK_CREATED,
            task_id=1,
            subtask_id=2,
            data={
                "block": {
                    "id": "reasoning-1",
                    "type": "thinking",
                    "content": "raw private reasoning",
                    "status": "streaming",
                }
            },
        )
    )
    await emitter.emit(
        ExecutionEvent.create(
            EventType.BLOCK_CREATED,
            task_id=1,
            subtask_id=2,
            data={
                "block": {
                    "id": "commentary-1",
                    "type": "text",
                    "content": "**检查配置**\n token=supersecretvalue",
                    "status": "streaming",
                }
            },
        )
    )

    all_updates = "".join(card_factory[0].updates)
    assert "raw private reasoning" not in all_updates
    assert "supersecretvalue" not in all_updates
    assert "检查配置" in card_factory[0].updates[-1]
    assert "raw private reasoning" not in str(emitter._progress.to_dict())


@pytest.mark.asyncio
async def test_block_update_reuses_tool_name_without_exposing_output(
    emitter, card_factory
):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit(
        ExecutionEvent.create(
            EventType.BLOCK_CREATED,
            task_id=1,
            subtask_id=2,
            data={
                "block": {
                    "id": "tool-1",
                    "type": "tool",
                    "tool_name": "Bash",
                    "status": "pending",
                }
            },
        )
    )
    await emitter.emit(
        ExecutionEvent.create(
            EventType.BLOCK_UPDATED,
            task_id=1,
            subtask_id=2,
            data={
                "block_id": "tool-1",
                "updates": {
                    "status": "done",
                    "tool_output": "do not show this output",
                },
            },
        )
    )

    rendered = card_factory[0].updates[-1]
    assert "工具完成：Bash" in rendered
    assert "do not show this output" not in "".join(card_factory[0].updates)


@pytest.mark.asyncio
async def test_interactive_block_points_user_back_to_wework(emitter, card_factory):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit(
        ExecutionEvent.create(
            EventType.BLOCK_CREATED,
            task_id=1,
            subtask_id=2,
            data={
                "block": {
                    "id": "input-1",
                    "type": "tool",
                    "tool_name": "request_user_input",
                    "tool_input": {"question": "secret question"},
                    "status": "pending",
                    "render_payload": {"kind": "request_user_input"},
                }
            },
        )
    )

    rendered = card_factory[0].updates[-1]
    assert "等待你在 Wework 中确认" in rendered
    assert "secret question" not in rendered


@pytest.mark.asyncio
async def test_answer_stream_and_terminal_result_replace_progress(
    emitter, card_factory
):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit_thinking(task_id=1, subtask_id=2)
    await emitter.emit_chunk(task_id=1, subtask_id=2, content="部分回答", offset=4)

    card = card_factory[0]
    assert card.updates[-1] == "部分回答"
    assert "执行进度" not in card.updates[-1]

    await emitter.emit_done(
        task_id=1,
        subtask_id=2,
        result={"value": "最终回答"},
    )

    assert card.finished == ["最终回答"]
    assert card.updates[-1] == "最终回答"
    assert "正在分析" not in card.finished[-1]


@pytest.mark.asyncio
async def test_terminal_result_uses_consistent_length_limit(emitter, card_factory):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit_done(
        task_id=1,
        subtask_id=2,
        result={"value": "答" * 5000},
    )

    final = card_factory[0].finished[-1]
    assert len(final) == emitter.MAX_FINAL_CONTENT_LENGTH
    assert "内容已截断" in final


@pytest.mark.asyncio
async def test_structured_terminal_output_does_not_replace_streamed_answer(
    emitter, card_factory
):
    await emitter.emit_start(task_id=1, subtask_id=2)
    await emitter.emit_chunk(task_id=1, subtask_id=2, content="最终回答", offset=4)
    await emitter.emit_done(
        task_id=1,
        subtask_id=2,
        result={"output": [{"type": "internal", "content": "do not render"}]},
    )

    final = card_factory[0].finished[-1]
    assert final == "最终回答"
    assert "do not render" not in final


@pytest.mark.asyncio
async def test_shared_progress_survives_worker_reconstruction_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)

    first = StreamingResponseEmitter(object(), object())
    first.set_shared_content_key("channel:streaming_content:task-1")
    first._may_update_display = AsyncMock(return_value=True)
    await first.emit_start(task_id="task-1", subtask_id=2)
    await first.emit(
        ExecutionEvent.create(
            EventType.TOOL_RESULT,
            task_id=1,
            subtask_id=2,
            tool_name="Read",
            data={"status": "completed"},
        )
    )

    second = StreamingResponseEmitter(
        object(),
        object(),
        existing_card_instance_id="card-1",
    )
    second.set_shared_content_key("channel:streaming_content:task-1")
    second._may_update_display = AsyncMock(return_value=True)
    await second.emit_start(task_id="task-1", subtask_id=2)
    await second.emit(
        ExecutionEvent.create(
            EventType.BLOCK_CREATED,
            task_id=1,
            subtask_id=2,
            data={
                "block": {
                    "id": "commentary-1",
                    "type": "text",
                    "content": "检查完成",
                    "status": "done",
                }
            },
        )
    )

    state_key = "channel:streaming_content:task-1:progress"
    assert cache.structured[state_key]["recent"] == [
        "工具完成：Read",
        "检查完成",
    ]

    await second.emit_done(
        task_id="task-1",
        subtask_id=2,
        result={"value": "完成"},
    )
    assert state_key not in cache.structured
    assert "channel:streaming_content:task-1" not in cache.raw


@pytest.mark.asyncio
async def test_display_throttle_does_not_drop_shared_progress(
    monkeypatch: pytest.MonkeyPatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object())
    emitter.set_shared_content_key("channel:streaming_content:task-2")
    await emitter.emit_start(task_id="task-2", subtask_id=2)
    emitter._may_update_display = AsyncMock(return_value=False)

    await emitter.emit(
        ExecutionEvent.create(
            EventType.TOOL_RESULT,
            task_id=1,
            subtask_id=2,
            tool_name="Read",
            data={"status": "completed"},
        )
    )

    state = cache.structured["channel:streaming_content:task-2:progress"]
    assert state["recent"] == ["工具完成：Read"]
