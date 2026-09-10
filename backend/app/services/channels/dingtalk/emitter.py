# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk response emitters backed by a single AI Card."""

import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional

from app.core.cache import cache_manager
from app.services.channels.emitter import SyncResponseEmitter
from app.services.execution.emitters import ResultEmitter
from shared.models import EventType, ExecutionEvent
from shared.telemetry.decorators import trace_async
from shared.utils.sensitive_data_masker import mask_string

if TYPE_CHECKING:
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.stream import DingTalkStreamClient

logger = logging.getLogger(__name__)

__all__ = ["SyncResponseEmitter", "StreamingResponseEmitter"]

_MARKDOWN_TOKEN_RE = re.compile(r"[`*_>#]+")
_CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]+")
_WAITING_FOR_INPUT_CONTENT = "等待你在 Wework 中确认后继续。"
_EMPTY_FINAL_CONTENT = "本轮已结束，未生成最终回复。"


def _safe_single_line(value: Any) -> str:
    """Return one masked, normalized line for the compact IM projection."""
    if not isinstance(value, str):
        return ""
    text = mask_string(value)
    text = _CONTROL_CHARACTER_RE.sub(" ", text)
    text = _MARKDOWN_TOKEN_RE.sub("", text)
    return " ".join(text.split()).strip()


def _compact_text(value: Any, limit: int) -> str:
    """Return one safe, bounded line for the compact IM projection."""
    text = _safe_single_line(value)
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


@dataclass
class _CompactProgressState:
    """Serializable, bounded DingTalk progress projection."""

    mode: str = "progress"
    current: str = "正在理解需求…"
    recent: list[str] = field(default_factory=list)
    blocks: dict[str, dict[str, Any]] = field(default_factory=dict)
    reasoning_summary: str = ""

    MAX_RECENT = 2
    MAX_BLOCKS = 20
    MAX_STEP_LENGTH = 80
    MAX_CARD_LENGTH = 320
    MAX_REASONING_LENGTH = 240

    @classmethod
    def from_dict(cls, value: Any) -> "_CompactProgressState":
        if not isinstance(value, dict):
            return cls()
        mode = (
            value.get("mode")
            if value.get("mode") in {"progress", "answer"}
            else "progress"
        )
        current = _compact_text(value.get("current"), cls.MAX_STEP_LENGTH)
        recent = value.get("recent") if isinstance(value.get("recent"), list) else []
        recent = [
            text
            for item in recent[-cls.MAX_RECENT :]
            if (text := _compact_text(item, cls.MAX_STEP_LENGTH))
        ]
        blocks = value.get("blocks") if isinstance(value.get("blocks"), dict) else {}
        safe_blocks = {
            str(block_id): _safe_block(block)
            for block_id, block in list(blocks.items())[-cls.MAX_BLOCKS :]
            if isinstance(block, dict)
        }
        reasoning_summary = _compact_text(
            value.get("reasoning_summary"), cls.MAX_REASONING_LENGTH
        )
        return cls(
            mode=mode,
            current=current or "正在处理…",
            recent=recent,
            blocks=safe_blocks,
            reasoning_summary=reasoning_summary,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "current": self.current,
            "recent": self.recent[-self.MAX_RECENT :],
            "blocks": self.blocks,
            "reasoning_summary": self.reasoning_summary,
        }

    def set_current(self, value: str) -> None:
        text = _compact_text(value, self.MAX_STEP_LENGTH)
        if text:
            self.reasoning_summary = ""
            self.current = text

    def append_reasoning_summary(self, value: str) -> None:
        separator = " " if self.reasoning_summary and value[:1].isspace() else ""
        summary = _safe_single_line(f"{self.reasoning_summary}{separator}{value}")
        if not summary:
            self.set_current("正在分析…")
            return
        summary = summary[-self.MAX_REASONING_LENGTH :]
        self.reasoning_summary = summary
        prefix = "正在分析："
        available = self.MAX_STEP_LENGTH - len(prefix)
        visible = summary
        if len(visible) > available:
            visible = f"…{visible[-(available - 1):]}"
        self.current = f"{prefix}{visible}"

    def complete(self, value: str) -> None:
        text = _compact_text(value, self.MAX_STEP_LENGTH)
        if text and (not self.recent or self.recent[-1] != text):
            self.recent.append(text)
            self.recent = self.recent[-self.MAX_RECENT :]
        self.reasoning_summary = ""
        self.current = "继续处理…"

    def remember_block(self, block: dict[str, Any]) -> None:
        block_id = str(block.get("id") or "").strip()
        if not block_id:
            return
        if block_id not in self.blocks and len(self.blocks) >= self.MAX_BLOCKS:
            self.blocks.pop(next(iter(self.blocks)))
        self.blocks[block_id] = block

    def render(self) -> str:
        lines = ["**执行进度**"]
        lines.extend(f"✅ {item}" for item in self.recent[-self.MAX_RECENT :])
        lines.append(f"⏳ {self.current or '正在处理…'}")
        return "\n".join(lines)[: self.MAX_CARD_LENGTH]


def _safe_block(block: Any) -> dict[str, Any]:
    """Keep only fields needed to project a block safely."""
    if not isinstance(block, dict):
        return {}
    block_type = _compact_text(block.get("type"), 24).lower()
    safe = {
        "id": str(block.get("id") or "").strip(),
        "type": block_type,
        "status": _compact_text(block.get("status"), 24).lower(),
        "process_kind": _compact_text(block.get("process_kind"), 32).lower(),
        "tool_name": _compact_text(block.get("tool_name"), 40),
        "display_name": _compact_text(block.get("display_name"), 40),
        "title": _compact_text(block.get("title"), 80),
        "agent_type": _compact_text(block.get("agent_type"), 40),
    }
    if block_type in {"text", "plan"}:
        safe["content"] = _compact_text(block.get("content"), 80)
    render_payload = block.get("render_payload")
    safe["needs_input"] = bool(
        block.get("needs_input")
        or (
            isinstance(render_payload, dict)
            and render_payload.get("kind") == "request_user_input"
        )
        or safe["tool_name"] == "request_user_input"
    )
    return safe


def _merge_safe_block(
    existing: dict[str, Any], updates: Any, block_id: str
) -> dict[str, Any]:
    if not isinstance(updates, dict):
        return existing
    merged = {**existing, "id": block_id}
    for key in (
        "type",
        "status",
        "process_kind",
        "tool_name",
        "display_name",
        "title",
        "agent_type",
        "content",
        "render_payload",
    ):
        if key in updates:
            merged[key] = updates[key]
    return _safe_block(merged)


def _tool_label(value: dict[str, Any]) -> str:
    return value.get("display_name") or value.get("tool_name") or "工具"


def _project_block(state: _CompactProgressState, block: dict[str, Any]) -> None:
    if not block:
        return
    status = block.get("status") or "pending"
    block_type = block.get("type")
    if block.get("needs_input"):
        state.set_current("等待你在 Wework 中确认…")
    elif block_type == "thinking":
        state.set_current("正在分析…")
    elif block_type == "tool":
        _project_tool_block(state, block, status)
    elif block_type == "subagent":
        _project_subagent_block(state, block, status)
    elif block_type in {"text", "plan"}:
        _project_text_block(state, block, status)
    else:
        state.set_current("正在处理新步骤…")


def _project_tool_block(
    state: _CompactProgressState, block: dict[str, Any], status: str
) -> None:
    label = _tool_label(block)
    if status in {"error", "failed"}:
        state.set_current(f"工具执行失败：{label}")
    elif status in {"done", "completed", "success"}:
        state.complete(f"工具完成：{label}")
    else:
        state.set_current(f"正在使用工具：{label}")


def _project_subagent_block(
    state: _CompactProgressState, block: dict[str, Any], status: str
) -> None:
    label = block.get("title") or block.get("display_name") or block.get("agent_type")
    label = label or "协作任务"
    if status in {"error", "failed"}:
        state.set_current(f"协作任务失败：{label}")
    elif status in {"done", "completed", "success"}:
        state.complete(f"协作任务完成：{label}")
    else:
        state.set_current(f"正在协同处理：{label}")


def _project_text_block(
    state: _CompactProgressState, block: dict[str, Any], status: str
) -> None:
    content = block.get("content")
    if not content:
        state.set_current("正在整理过程…")
    elif status in {"done", "completed", "success"}:
        state.complete(content)
    else:
        state.set_current(content)


class StreamingResponseEmitter(ResultEmitter):
    """Render compact progress and the final answer into one DingTalk AI Card."""

    MIN_UPDATE_INTERVAL = 0.5
    MAX_FINAL_CONTENT_LENGTH = 4000
    MAX_ERROR_CONTENT_LENGTH = 300
    FINAL_TRUNCATION_SUFFIX = "\n\n…（内容已截断，请在 Wework 查看完整结果）"
    PROGRESS_STATE_SUFFIX = ":progress"
    DISPLAY_LOCK_SUFFIX = ":display-lock"

    def __init__(
        self,
        dingtalk_client: "DingTalkStreamClient",
        incoming_message: "ChatbotMessage",
        existing_card_instance_id: Optional[str] = None,
    ):
        from app.services.channels.dingtalk.card import DingTalkMarkdownCard

        self._dingtalk_client = dingtalk_client
        self._incoming_message = incoming_message
        self._card = DingTalkMarkdownCard(dingtalk_client, incoming_message)
        self._card.set_order(["msgContent"])
        self._full_content = ""
        self._pending_content = ""
        self._last_update_time = 0.0
        self._finished = False
        self._shared_content_key: Optional[str] = None
        self._progress = _CompactProgressState()
        self._update_lock = asyncio.Lock()
        self._reconnected = bool(existing_card_instance_id)
        self._initialized = False
        self._dirty = False
        self._finishing = False
        self._closed = False
        self._flush_task: Optional[asyncio.Task[None]] = None
        self._flush_error: Optional[Exception] = None
        self._lease_renewal: Optional[asyncio.Task[None]] = None
        self._flush_now = asyncio.Event()
        self._pending_progress: list[Callable[[_CompactProgressState], None]] = []

        if existing_card_instance_id:
            self._card.card_instance_id = existing_card_instance_id
            self._started = True
        else:
            self._started = False

    @property
    def card_instance_id(self) -> Optional[str]:
        return self._card.card_instance_id if self._card else None

    @property
    def _answer_key(self) -> Optional[str]:
        if not self._shared_content_key:
            return None
        return f"{self._shared_content_key}:{self.card_instance_id}"

    @property
    def _progress_state_key(self) -> Optional[str]:
        if not self._answer_key:
            return None
        return f"{self._answer_key}{self.PROGRESS_STATE_SUFFIX}"

    @property
    def _display_lock_key(self) -> Optional[str]:
        if not self._answer_key:
            return None
        return f"{self._answer_key}{self.DISPLAY_LOCK_SUFFIX}"

    def set_shared_content_key(self, key: str) -> None:
        """Enable Redis-backed answer and progress state sharing."""
        self._shared_content_key = key

    async def _ensure_card_started(self) -> bool:
        if self._started:
            return True
        try:
            logger.info("[StreamingEmitter] Starting AI card...")
            await self._call_card("ai_start")
            if not self._card.card_instance_id:
                logger.error("[StreamingEmitter] AI card has no instance ID")
                return False
            self._started = True
            logger.info(
                "[StreamingEmitter] AI card started: instance_id=%s",
                self._card.card_instance_id,
            )
            return True
        except Exception:
            logger.exception("[StreamingEmitter] Failed to start AI card")
            return False

    async def _load_progress_state(self) -> None:
        key = self._progress_state_key
        if key:
            cached = await cache_manager.get(key)
            if cached is not None:
                self._progress = _CompactProgressState.from_dict(cached)

    async def _save_progress_state(self, state: Optional[dict] = None) -> None:
        key = self._progress_state_key
        if not key:
            return
        from app.services.channels.callback import CHANNEL_TASK_CALLBACK_TTL

        saved = await cache_manager.set(
            key,
            state if state is not None else self._progress.to_dict(),
            expire=CHANNEL_TASK_CALLBACK_TTL,
        )
        if not saved:
            logger.warning("[StreamingEmitter] Failed to persist compact progress")

    async def _redis_append_answer(self, content: str) -> None:
        from app.services.channels.callback import CHANNEL_TASK_CALLBACK_TTL

        redis_client = await cache_manager._get_client()
        try:
            await redis_client.append(self._answer_key, content.encode("utf-8"))
            await redis_client.expire(self._answer_key, CHANNEL_TASK_CALLBACK_TTL)
        finally:
            await redis_client.aclose()

    async def _redis_get_answer(self) -> str:
        redis_client = await cache_manager._get_client()
        try:
            raw = await redis_client.get(self._answer_key)
            return raw.decode("utf-8") if raw else ""
        finally:
            await redis_client.aclose()

    async def _redis_cleanup(self) -> None:
        if not self._shared_content_key:
            return
        keys = [self._answer_key]
        keys.extend(
            key for key in (self._progress_state_key, self._display_lock_key) if key
        )
        try:
            redis_client = await cache_manager._get_client()
            try:
                await redis_client.delete(*keys)
            finally:
                await redis_client.aclose()
        except Exception:
            logger.exception("[StreamingEmitter] Failed to clean shared card state")

    async def _may_update_display(self, force: bool) -> bool:
        if force or self.MIN_UPDATE_INTERVAL <= 0:
            return True
        if self._display_lock_key:
            redis_client = await cache_manager._get_client()
            try:
                allowed = await redis_client.set(
                    self._display_lock_key,
                    b"1",
                    nx=True,
                    px=int(self.MIN_UPDATE_INTERVAL * 1000),
                )
                return bool(allowed)
            finally:
                await redis_client.aclose()
        return time.monotonic() - self._last_update_time >= self.MIN_UPDATE_INTERVAL

    async def _write_card(self, content: str, *, force: bool = False) -> bool:
        if self._finished or not self._card.card_instance_id or not content:
            return False
        if not await self._may_update_display(force):
            return False
        try:
            await self._call_card("ai_streaming", content, append=False)
            self._last_update_time = time.monotonic()
            return True
        except Exception:
            logger.exception("[StreamingEmitter] Failed to update AI card")
            return False

    async def _render_current_mode(self, *, force: bool = False) -> None:
        if self._progress.mode == "answer":
            answer = await self._current_answer()
            await self._write_card(self._truncate_final(answer), force=force)
            return
        await self._write_card(self._progress.render(), force=force)

    async def _initialize(self) -> bool:
        if self._initialized:
            return True
        async with self._update_lock:
            if not self._initialized:
                if not await self._ensure_card_started():
                    return False
                await self._load_progress_state()
                self._initialized = True
        return True

    def _schedule_update(self) -> None:
        if self._flush_error is not None:
            return
        self._dirty = True
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._run_updates())

    @trace_async(span_name="dingtalk.flush_updates", tracer_name=__name__)
    async def _run_updates(self) -> None:
        try:
            while self._dirty and not self._finishing:
                delay = max(
                    0,
                    self.MIN_UPDATE_INTERVAL
                    - (time.monotonic() - self._last_update_time),
                )
                if delay and not self._flush_now.is_set():
                    try:
                        await asyncio.wait_for(self._flush_now.wait(), timeout=delay)
                    except asyncio.TimeoutError:
                        pass
                self._flush_now.clear()
                if self._finishing:
                    break
                async with self._update_lock:
                    async with self._shared_write():
                        if not self._finished:
                            await self._flush_pending()
        except Exception as exc:
            # A failed APPEND may already have reached Redis. Do not replay it or
            # finalize from potentially incomplete content; DONE has the snapshot.
            self._flush_error = exc
            logger.exception("[StreamingEmitter] Failed to flush card update")
        finally:
            self._flush_task = None

    async def flush(self) -> None:
        """Wait for the latest coalesced display state to be persisted and sent."""
        self._flush_now.set()
        if self._flush_task is not None:
            await asyncio.shield(self._flush_task)

    async def _stop_updates(self) -> None:
        """Drop pending displays and let an in-flight write finish before terminal."""
        if self._closed and not self._finished:
            raise RuntimeError("Cannot finish a closed DingTalk emitter")
        self._finishing = True
        await self.flush()
        self._pending_progress.clear()
        if not await self._initialize():
            raise RuntimeError("Failed to initialize DingTalk card")

    async def _flush_pending(self) -> None:
        self._dirty = False
        updates, self._pending_progress = self._pending_progress, []
        content, self._pending_content = self._pending_content, ""
        started = time.monotonic()
        state = _CompactProgressState.from_dict(self._progress.to_dict())
        if self._progress_state_key:
            cached = await cache_manager.get(self._progress_state_key)
            state = _CompactProgressState.from_dict(cached)
            if state.mode == "progress":
                for update in updates:
                    update(state)
        if content:
            state.mode = "answer"
        # Keep local projection current, including events received during the read.
        self._progress = _CompactProgressState.from_dict(state.to_dict())
        if self._progress.mode == "progress":
            for update in self._pending_progress:
                update(self._progress)
        if self._pending_content:
            self._progress.mode = "answer"
        await self._save_progress_state(state.to_dict())
        if self._shared_content_key:
            if content:
                await self._redis_append_answer(content)
            if state.mode == "answer":
                self._full_content = await self._redis_get_answer()
        else:
            self._full_content += content
        logger.info(
            "[StreamingEmitter] persist card=%s duration_ms=%.2f content_len=%d",
            self.card_instance_id,
            (time.monotonic() - started) * 1000,
            len(content),
        )
        if not self._finishing:
            display = (
                self._truncate_final(self._full_content)
                if state.mode == "answer"
                else state.render()
            )
            await self._write_card(display)
        # Also throttle batches when another worker owns the display interval.
        self._last_update_time = time.monotonic()

    async def _update_progress(
        self, updater: Callable[[_CompactProgressState], None]
    ) -> None:
        if self._finished or self._finishing or self._closed:
            return
        if not await self._initialize() or self._progress.mode != "progress":
            return
        if self._finished or self._finishing or self._closed:
            return
        updater(self._progress)
        self._pending_progress.append(updater)
        self._schedule_update()

    async def _current_answer(self) -> str:
        if self._flush_error is not None:
            raise RuntimeError(
                "Card persistence failed; authoritative result required"
            ) from self._flush_error
        content = (
            await self._redis_get_answer()
            if self._shared_content_key
            else self._full_content
        )
        return f"{content}{self._pending_content}"

    @trace_async(span_name="dingtalk.card_request", tracer_name=__name__)
    async def _call_card(self, method: str, *args: Any, **kwargs: Any) -> None:
        """Keep synchronous SDK I/O off the event loop and preserve write order."""
        self._check_writer_lease()
        started = time.monotonic()
        call = asyncio.create_task(
            asyncio.to_thread(getattr(self._card, method), *args, **kwargs)
        )
        cancelled = False
        try:
            while not call.done():
                try:
                    await asyncio.shield(call)
                except asyncio.CancelledError:
                    # Repeated cancellation still cannot stop the SDK thread.
                    # Keep the lock until the actual network request has exited.
                    cancelled = True
            call.result()
            if cancelled:
                raise asyncio.CancelledError
        finally:
            logger.info(
                "[StreamingEmitter] card_request method=%s card=%s duration_ms=%.2f",
                method,
                self.card_instance_id,
                (time.monotonic() - started) * 1000,
            )

    @property
    def _terminal_key(self) -> str:
        # A task may have multiple turns; scope terminal state to the actual card.
        return f"{self._answer_key}:terminal"

    def _check_writer_lease(self) -> None:
        if self._lease_renewal is not None and self._lease_renewal.done():
            self._lease_renewal.result()

    @asynccontextmanager
    async def _shared_write(self) -> AsyncIterator[None]:
        """Serialize reconstructed workers and reject updates after completion."""
        if not self._shared_content_key:
            yield
            return
        client = await cache_manager._get_client()
        try:
            lock = client.lock(
                f"{self._terminal_key}:writer", timeout=60, blocking_timeout=60
            )
            async with lock:
                renewal = asyncio.create_task(self._renew_writer_lock(lock))
                self._lease_renewal = renewal
                try:
                    if await client.get(self._terminal_key):
                        self._finished = True
                        self._dirty = False
                    yield
                    self._check_writer_lease()
                finally:
                    renewal.cancel()
                    await asyncio.gather(renewal, return_exceptions=True)
                    self._lease_renewal = None
        finally:
            await client.aclose()

    async def _renew_writer_lock(self, lock: Any) -> None:
        """Keep the lease while a synchronous SDK request is still in flight."""
        try:
            while True:
                await asyncio.sleep(20)
                await lock.extend(60, replace_ttl=True)
        except Exception:
            logger.exception("[StreamingEmitter] Failed to renew card writer lease")
            raise

    async def _mark_finished(self) -> None:
        self._check_writer_lease()
        if self._shared_content_key:
            from app.services.channels.callback import CHANNEL_TASK_CALLBACK_TTL

            saved = await cache_manager.set(
                self._terminal_key, True, expire=CHANNEL_TASK_CALLBACK_TTL
            )
            if not saved:
                raise RuntimeError("Failed to persist card terminal marker")
        self._check_writer_lease()
        self._finished = True

    def _truncate_final(self, content: str, *, max_length: Optional[int] = None) -> str:
        limit = self.MAX_FINAL_CONTENT_LENGTH if max_length is None else max_length
        suffix = self.FINAL_TRUNCATION_SUFFIX
        if len(content) <= limit:
            return content
        return f"{content[: limit - len(suffix)]}{suffix}"

    async def emit(self, event: ExecutionEvent) -> None:
        event_type = (
            event.type.value if isinstance(event.type, EventType) else event.type
        )
        if event_type == EventType.START.value:
            await self.emit_start(event.task_id, event.subtask_id, event.message_id)
        elif event_type == EventType.CHUNK.value:
            await self.emit_chunk(
                event.task_id, event.subtask_id, event.content or "", event.offset
            )
        elif event_type == EventType.THINKING.value:
            await self.emit_thinking(
                event.task_id,
                event.subtask_id,
                content=event.content or "",
                is_reasoning_summary=(event.data or {}).get("thinking_kind")
                == "reasoning_summary",
            )
        elif event_type == EventType.TOOL_START.value:
            await self.emit_tool_start(event)
        elif event_type == EventType.TOOL_RESULT.value:
            await self.emit_tool_result(event)
        elif event_type == EventType.BLOCK_CREATED.value:
            await self.emit_block_created(event)
        elif event_type == EventType.BLOCK_UPDATED.value:
            await self.emit_block_updated(event)
        elif event_type == EventType.STATUS_UPDATED.value:
            await self.emit_status_updated(event)
        elif event_type == EventType.PROGRESS.value:
            await self.emit_progress(event)
        elif event_type == EventType.DONE.value:
            await self.emit_done(event.task_id, event.subtask_id, event.result)
        elif event_type == EventType.ERROR.value:
            await self.emit_error(
                event.task_id, event.subtask_id, event.error or "Unknown error"
            )
        elif event_type in {EventType.CANCEL.value, EventType.CANCELLED.value}:
            await self.emit_cancelled(event.task_id, event.subtask_id)

    async def emit_start(
        self,
        task_id: Any,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs: Any,
    ) -> None:
        logger.info("[StreamingEmitter] start task=%s subtask=%s", task_id, subtask_id)
        if self._finished or self._finishing or self._closed:
            return
        if not await self._initialize():
            return
        async with self._update_lock:
            async with self._shared_write():
                if self._finished or self._finishing or self._closed:
                    return
                await self._load_progress_state()
                await self._save_progress_state()
                if not self._reconnected:
                    await self._render_current_mode(force=True)

    async def emit_thinking(
        self,
        task_id: Any,
        subtask_id: int,
        content: str = "",
        is_reasoning_summary: bool = False,
    ) -> None:
        if content and is_reasoning_summary:
            await self._update_progress(
                lambda state: state.append_reasoning_summary(content)
            )
            return
        await self._update_progress(lambda state: state.set_current("正在分析…"))

    async def emit_status_prefix(
        self,
        task_id: Any,
        subtask_id: int,
        content: str,
        **kwargs: Any,
    ) -> None:
        """Show dispatch acknowledgement as progress, not answer content."""
        await self._update_progress(lambda state: state.set_current(content))

    async def emit_tool_start(self, event: ExecutionEvent) -> None:
        label = _compact_text(
            (event.data or {}).get("display_name") or event.tool_name, 40
        )
        await self._update_progress(
            lambda state: state.set_current(f"正在使用工具：{label or '工具'}")
        )

    async def emit_tool_result(self, event: ExecutionEvent) -> None:
        label = _compact_text(
            (event.data or {}).get("display_name") or event.tool_name, 40
        )
        status = str((event.data or {}).get("status") or "").lower()
        failed = status in {"error", "failed"} or bool((event.data or {}).get("error"))

        def update(state: _CompactProgressState) -> None:
            if failed:
                state.set_current(f"工具执行失败：{label or '工具'}")
            else:
                state.complete(f"工具完成：{label or '工具'}")

        await self._update_progress(update)

    async def emit_block_created(self, event: ExecutionEvent) -> None:
        block = _safe_block((event.data or {}).get("block"))

        def update(state: _CompactProgressState) -> None:
            state.remember_block(block)
            _project_block(state, block)

        await self._update_progress(update)

    async def emit_block_updated(self, event: ExecutionEvent) -> None:
        block_id = str((event.data or {}).get("block_id") or "").strip()
        updates = (event.data or {}).get("updates")
        if not block_id or not isinstance(updates, dict):
            return

        def update(state: _CompactProgressState) -> None:
            existing = state.blocks.get(block_id, {"id": block_id})
            block = _merge_safe_block(existing, updates, block_id)
            state.remember_block(block)
            _project_block(state, block)

        await self._update_progress(update)

    async def emit_status_updated(self, event: ExecutionEvent) -> None:
        data = event.data or {}
        phase = str(data.get("phase") or "").lower()
        if data.get("context_compaction") or phase == "summary_compact":
            await self._update_progress(
                lambda state: state.set_current("正在整理上下文…")
            )

    async def emit_progress(self, event: ExecutionEvent) -> None:
        progress = max(0, min(int(event.progress or 0), 100))
        status = _compact_text(event.status, 50)
        if not progress and not status:
            return
        text = f"任务进度 {progress}%" if progress else "正在处理"
        if status:
            text = f"{text}：{status}"
        await self._update_progress(lambda state: state.set_current(text))

    async def emit_chunk(
        self,
        task_id: Any,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs: Any,
    ) -> None:
        if not content or self._finished or self._finishing or self._closed:
            return
        if not await self._initialize():
            return
        if self._finished or self._finishing or self._closed:
            return
        self._progress.mode = "answer"
        self._pending_content += content
        self._schedule_update()

    async def _final_content(self, result: Optional[dict]) -> str:
        if isinstance(result, dict):
            authoritative = result.get(
                "silent_exit_reason"
            ) != "waiting_for_user_input" and result.get("value_origin") not in {
                "process_fallback",
                "empty",
            }
            if authoritative:
                for field_name in ("value", "output"):
                    value = result.get(field_name)
                    if isinstance(value, str) and value:
                        return self._truncate_final(value)
        content = await self._current_answer()
        if (
            isinstance(result, dict)
            and result.get("silent_exit_reason") == "waiting_for_user_input"
        ):
            return self._truncate_final(content or _WAITING_FOR_INPUT_CONTENT)
        return self._truncate_final(content or _EMPTY_FINAL_CONTENT)

    async def emit_done(
        self,
        task_id: Any,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs: Any,
    ) -> None:
        await self._stop_updates()
        async with self._update_lock, self._shared_write():
            if self._finished:
                logger.warning("[StreamingEmitter] emit_done called after finish")
                return
            final_content = await self._final_content(result)
            logger.info(
                "[StreamingEmitter] done task=%s subtask=%s content_len=%s",
                task_id,
                subtask_id,
                len(final_content),
            )
            await self._finish_card(final_content)

    async def _finish_card(self, content: str, *, failed: bool = False) -> None:
        """Only discard recovery state after terminal delivery and fencing succeed."""
        await self._call_card("ai_streaming", content, append=False)
        if failed:
            await self._call_card("ai_fail")
        else:
            await asyncio.sleep(0.1)
            await self._call_card("ai_finish", content)
        await self._mark_finished()
        self._progress.mode = "answer"
        self._full_content = content
        self._pending_content = ""
        self._dirty = False
        await self._redis_cleanup()

    async def emit_error(
        self,
        task_id: Any,
        subtask_id: int,
        error: str,
        **kwargs: Any,
    ) -> None:
        await self._stop_updates()
        async with self._update_lock, self._shared_write():
            if self._finished:
                return
            logger.warning(
                "[StreamingEmitter] error task=%s subtask=%s error=%s",
                task_id,
                subtask_id,
                mask_string(error),
            )
            # ai_fail alone leaves a blank body; deliver the error text first.
            error_text = _compact_text(error, self.MAX_ERROR_CONTENT_LENGTH)
            content = (
                f"❌ 任务执行失败：{error_text}" if error_text else "❌ 任务执行失败"
            )
            await self._finish_card(content, failed=True)

    async def emit_cancelled(
        self,
        task_id: Any,
        subtask_id: int,
        **kwargs: Any,
    ) -> None:
        await self._stop_updates()
        async with self._update_lock, self._shared_write():
            if self._finished:
                return
            answer = (await self._current_answer()).rstrip()
            suffix = "\n\n⚠️ 任务已取消"
            content = (
                self._truncate_final(
                    answer, max_length=self.MAX_FINAL_CONTENT_LENGTH - len(suffix)
                )
                + suffix
                if answer
                else suffix.strip()
            )
            await self._finish_card(content)

    async def close(self) -> None:
        self._closed = True
        await self.flush()
        # Terminal failure may leave buffered text. Persist it for reconstruction;
        # closing a local worker must not delete another worker's recovery state.
        if self._pending_content and not self._finished and self._flush_error is None:
            async with self._update_lock, self._shared_write():
                if not self._finished:
                    await self._flush_pending()
