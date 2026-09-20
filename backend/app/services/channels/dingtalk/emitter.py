# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk response emitters backed by a single AI Card."""

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, Callable, Optional

from app.core.cache import cache_manager
from app.schemas.dingtalk_card import DingTalkChatCardConfig
from app.services.channels.dingtalk.card_adapter import create_card_adapter
from app.services.channels.dingtalk.card_progress import (
    CompactProgressState,
    compact_text,
    merge_safe_block,
    project_block,
    safe_block,
)
from app.services.channels.dingtalk.message_logging import log_dingtalk_message
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

_WAITING_FOR_INPUT_CONTENT = "等待你在 Wework 中确认后继续。"
_EMPTY_FINAL_CONTENT = "本轮已结束，未生成最终回复。"


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
        chat_card: Optional[DingTalkChatCardConfig] = None,
        channel_id: int = 0,
    ):
        self._dingtalk_client = dingtalk_client
        self._incoming_message = incoming_message
        self.chat_card = chat_card
        self.subtask_id = 0
        self._card = create_card_adapter(
            dingtalk_client,
            incoming_message,
            chat_card,
            channel_id,
            existing_card_instance_id,
        )
        self._full_content = ""
        self._pending_content = ""
        self._last_update_time = 0.0
        self._finished = False
        self._shared_content_key: Optional[str] = None
        self._progress = CompactProgressState()
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
        self._pending_progress: list[Callable[[CompactProgressState], None]] = []

        if existing_card_instance_id:
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
        if self.chat_card:
            key = f"{key}:{self._card.out_track_id}"
        self._shared_content_key = key

    async def _ensure_card_started(self) -> bool:
        if self._started:
            return True
        try:
            logger.info("[StreamingEmitter] Starting AI card...")
            await self._call_card("start")
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
                self._progress = CompactProgressState.from_dict(cached)

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

    async def _save_final_answer(self, content: str) -> None:
        if not self._shared_content_key:
            return
        from app.services.channels.callback import CHANNEL_TASK_CALLBACK_TTL

        client = await cache_manager._get_client()
        try:
            await client.set(self._answer_key, content.encode("utf-8"))
            await client.expire(self._answer_key, CHANNEL_TASK_CALLBACK_TTL)
        finally:
            await client.aclose()

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
            await self._call_card("update", content)
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
        state = CompactProgressState.from_dict(self._progress.to_dict())
        if self._progress_state_key:
            cached = await cache_manager.get(self._progress_state_key)
            if cached is not None:
                state = CompactProgressState.from_dict(cached)
                if state.mode == "progress":
                    for update in updates:
                        update(state)
        if content:
            state.mode = "answer"
        # Keep local projection current, including events received during the read.
        self._progress = CompactProgressState.from_dict(state.to_dict())
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
        self, updater: Callable[[CompactProgressState], None]
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
        """Preserve adapter write order, including threaded SDK calls on cancellation."""
        self._check_writer_lease()
        started = time.monotonic()
        call = asyncio.create_task(getattr(self._card, method)(*args, **kwargs))
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
                # Reset the owned lease without a PTTL read in the Lua script.
                await lock.reacquire()
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
        self.subtask_id = subtask_id
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
        label = compact_text(
            (event.data or {}).get("display_name") or event.tool_name, 40
        )
        await self._update_progress(
            lambda state: state.set_current(f"正在使用工具：{label or '工具'}")
        )

    async def emit_tool_result(self, event: ExecutionEvent) -> None:
        label = compact_text(
            (event.data or {}).get("display_name") or event.tool_name, 40
        )
        status = str((event.data or {}).get("status") or "").lower()
        failed = status in {"error", "failed"} or bool((event.data or {}).get("error"))

        def update(state: CompactProgressState) -> None:
            if failed:
                state.set_current(f"工具执行失败：{label or '工具'}")
            else:
                state.complete(f"工具完成：{label or '工具'}")

        await self._update_progress(update)

    async def emit_block_created(self, event: ExecutionEvent) -> None:
        block = safe_block((event.data or {}).get("block"))

        def update(state: CompactProgressState) -> None:
            state.remember_block(block)
            project_block(state, block)

        await self._update_progress(update)

    async def emit_block_updated(self, event: ExecutionEvent) -> None:
        block_id = str((event.data or {}).get("block_id") or "").strip()
        updates = (event.data or {}).get("updates")
        if not block_id or not isinstance(updates, dict):
            return

        def update(state: CompactProgressState) -> None:
            existing = state.blocks.get(block_id, {"id": block_id})
            block = merge_safe_block(existing, updates, block_id)
            state.remember_block(block)
            project_block(state, block)

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
        status = compact_text(event.status, 50)
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
            await self._save_final_answer(final_content)
            self._full_content = final_content
            self._pending_content = ""
            await self._finish_card(final_content)
            log_dingtalk_message(
                logger,
                "reply_finished",
                {
                    "task_id": task_id,
                    "subtask_id": subtask_id,
                    "card_instance_id": self.card_instance_id,
                    "conversation_id": getattr(
                        self._incoming_message, "conversation_id", None
                    ),
                    "incoming_msg_id": getattr(
                        self._incoming_message, "message_id", None
                    ),
                    "content": final_content,
                },
            )

    async def _finish_card(self, content: str, *, failed: bool = False) -> None:
        """Only discard recovery state after terminal delivery and fencing succeed."""
        await self._call_card("update", content)
        if failed:
            await self._call_card("fail", content)
        else:
            await asyncio.sleep(0.1)
            await self._call_card("finish", content)
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
            error_text = compact_text(error, self.MAX_ERROR_CONTENT_LENGTH)
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
        """Drain pending writes before releasing the adapter's HTTP resources."""
        self._closed = True
        try:
            await self.flush()
            # Preserve unfinished text for reconstruction by other workers.
            if (
                self._pending_content
                and not self._finished
                and self._flush_error is None
            ):
                async with self._update_lock, self._shared_write():
                    if not self._finished:
                        await self._flush_pending()
        finally:
            await self._card.close()
