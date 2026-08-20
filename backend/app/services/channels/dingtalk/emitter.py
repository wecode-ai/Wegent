# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk response emitters backed by a single AI Card."""

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional

from app.core.cache import cache_manager
from app.services.channels.emitter import SyncResponseEmitter
from app.services.execution.emitters import ResultEmitter
from shared.models import EventType, ExecutionEvent
from shared.utils.sensitive_data_masker import mask_string

if TYPE_CHECKING:
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.stream import DingTalkStreamClient

logger = logging.getLogger(__name__)

__all__ = ["SyncResponseEmitter", "StreamingResponseEmitter"]

_MARKDOWN_TOKEN_RE = re.compile(r"[`*_>#]+")
_CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]+")


def _compact_text(value: Any, limit: int) -> str:
    """Return one safe, bounded line for the compact IM projection."""
    if not isinstance(value, str):
        return ""
    text = mask_string(value)
    text = _CONTROL_CHARACTER_RE.sub(" ", text)
    text = _MARKDOWN_TOKEN_RE.sub("", text)
    text = " ".join(text.split()).strip()
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

    MAX_RECENT = 2
    MAX_BLOCKS = 20
    MAX_STEP_LENGTH = 80
    MAX_CARD_LENGTH = 320

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
        return cls(
            mode=mode,
            current=current or "正在处理…",
            recent=recent,
            blocks=safe_blocks,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "current": self.current,
            "recent": self.recent[-self.MAX_RECENT :],
            "blocks": self.blocks,
        }

    def set_current(self, value: str) -> None:
        text = _compact_text(value, self.MAX_STEP_LENGTH)
        if text:
            self.current = text

    def complete(self, value: str) -> None:
        text = _compact_text(value, self.MAX_STEP_LENGTH)
        if text and (not self.recent or self.recent[-1] != text):
            self.recent.append(text)
            self.recent = self.recent[-self.MAX_RECENT :]
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

    MIN_UPDATE_INTERVAL = 0.8
    MAX_FINAL_CONTENT_LENGTH = 4000
    FINAL_TRUNCATION_SUFFIX = "\n\n…（内容已截断，请在 Wework 查看完整结果）"
    PROGRESS_STATE_SUFFIX = ":progress"
    DISPLAY_LOCK_SUFFIX = ":display-lock"

    def __init__(
        self,
        dingtalk_client: "DingTalkStreamClient",
        incoming_message: "ChatbotMessage",
        existing_card_instance_id: Optional[str] = None,
    ):
        from dingtalk_stream import AIMarkdownCardInstance

        self._dingtalk_client = dingtalk_client
        self._incoming_message = incoming_message
        self._card = AIMarkdownCardInstance(dingtalk_client, incoming_message)
        self._card.set_order(["msgContent"])
        self._full_content = ""
        self._pending_content = ""
        self._last_update_time = 0.0
        self._finished = False
        self._shared_content_key: Optional[str] = None
        self._progress = _CompactProgressState()
        self._update_lock = asyncio.Lock()
        self._reconnected = bool(existing_card_instance_id)

        if existing_card_instance_id:
            self._card.card_instance_id = existing_card_instance_id
            self._started = True
        else:
            self._started = False

    @property
    def card_instance_id(self) -> Optional[str]:
        return self._card.card_instance_id if self._card else None

    @property
    def _progress_state_key(self) -> Optional[str]:
        if not self._shared_content_key:
            return None
        return f"{self._shared_content_key}{self.PROGRESS_STATE_SUFFIX}"

    @property
    def _display_lock_key(self) -> Optional[str]:
        if not self._shared_content_key:
            return None
        return f"{self._shared_content_key}{self.DISPLAY_LOCK_SUFFIX}"

    def set_shared_content_key(self, key: str) -> None:
        """Enable Redis-backed answer and progress state sharing."""
        self._shared_content_key = key

    async def _ensure_card_started(self) -> bool:
        if self._started:
            return True
        try:
            logger.info("[StreamingEmitter] Starting AI card...")
            self._card.ai_start()
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

    async def _save_progress_state(self) -> None:
        key = self._progress_state_key
        if not key:
            return
        from app.services.channels.callback import CHANNEL_TASK_CALLBACK_TTL

        saved = await cache_manager.set(
            key,
            self._progress.to_dict(),
            expire=CHANNEL_TASK_CALLBACK_TTL,
        )
        if not saved:
            logger.warning("[StreamingEmitter] Failed to persist compact progress")

    async def _redis_append_answer(self, content: str) -> None:
        from app.services.channels.callback import CHANNEL_TASK_CALLBACK_TTL

        redis_client = await cache_manager._get_client()
        try:
            await redis_client.append(self._shared_content_key, content.encode("utf-8"))
            await redis_client.expire(
                self._shared_content_key, CHANNEL_TASK_CALLBACK_TTL
            )
        finally:
            await redis_client.aclose()

    async def _redis_get_answer(self) -> str:
        redis_client = await cache_manager._get_client()
        try:
            raw = await redis_client.get(self._shared_content_key)
            return raw.decode("utf-8") if raw else ""
        finally:
            await redis_client.aclose()

    async def _redis_cleanup(self) -> None:
        if not self._shared_content_key:
            return
        keys = [self._shared_content_key]
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
        if force:
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
        return time.time() - self._last_update_time >= self.MIN_UPDATE_INTERVAL

    async def _write_card(self, content: str, *, force: bool = False) -> bool:
        if self._finished or not self._card.card_instance_id or not content:
            return False
        if not await self._may_update_display(force):
            return False
        try:
            self._card.ai_streaming(content, append=False)
            self._last_update_time = time.time()
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

    async def _update_progress(
        self, updater: Callable[[_CompactProgressState], None]
    ) -> None:
        async with self._update_lock:
            if self._finished or not await self._ensure_card_started():
                return
            await self._load_progress_state()
            if self._progress.mode != "progress":
                return
            updater(self._progress)
            await self._save_progress_state()
            await self._render_current_mode()

    async def _current_answer(self) -> str:
        if self._shared_content_key:
            return await self._redis_get_answer()
        return f"{self._full_content}{self._pending_content}"

    async def _send_answer_update(self, content: str) -> None:
        if self._shared_content_key:
            await self._redis_append_answer(content)
            if not await self._may_update_display(False):
                return
            self._full_content = await self._redis_get_answer()
        else:
            self._pending_content += content
            if not await self._may_update_display(False):
                return
            self._full_content += self._pending_content
            self._pending_content = ""
        await self._write_card_without_throttle(
            self._truncate_final(self._full_content)
        )

    async def _write_card_without_throttle(self, content: str) -> None:
        if not content:
            return
        try:
            self._card.ai_streaming(content, append=False)
            self._last_update_time = time.time()
        except Exception:
            logger.exception("[StreamingEmitter] Failed to stream answer")

    def _truncate_final(self, content: str) -> str:
        suffix = self.FINAL_TRUNCATION_SUFFIX
        if len(content) <= self.MAX_FINAL_CONTENT_LENGTH:
            return content
        return f"{content[: self.MAX_FINAL_CONTENT_LENGTH - len(suffix)]}{suffix}"

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
            await self.emit_thinking(event.task_id, event.subtask_id)
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
        async with self._update_lock:
            if not await self._ensure_card_started():
                return
            await self._load_progress_state()
            await self._save_progress_state()
            await self._render_current_mode(force=not self._reconnected)

    async def emit_thinking(self, task_id: Any, subtask_id: int) -> None:
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
        if not content:
            return
        async with self._update_lock:
            if self._finished or not await self._ensure_card_started():
                return
            await self._load_progress_state()
            self._progress.mode = "answer"
            await self._save_progress_state()
            await self._send_answer_update(content)

    async def _final_content(self, result: Optional[dict]) -> str:
        content = await self._current_answer()
        if isinstance(result, dict):
            for field_name in ("value", "output"):
                result_value = result.get(field_name)
                if isinstance(result_value, str) and result_value:
                    content = result_value
                    break
        return self._truncate_final(content)

    async def emit_done(
        self,
        task_id: Any,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs: Any,
    ) -> None:
        async with self._update_lock:
            if self._finished:
                logger.warning("[StreamingEmitter] emit_done called after finish")
                return
            try:
                if not await self._ensure_card_started():
                    return
                await self._load_progress_state()
                self._progress.mode = "answer"
                await self._save_progress_state()
                final_content = await self._final_content(result)
                self._pending_content = ""
                self._full_content = final_content
                logger.info(
                    "[StreamingEmitter] done task=%s subtask=%s content_len=%s",
                    task_id,
                    subtask_id,
                    len(final_content),
                )
                self._card.ai_streaming(final_content, append=False)
                await asyncio.sleep(0.1)
                self._card.ai_finish(final_content)
                self._finished = True
            except Exception:
                logger.exception("[StreamingEmitter] Failed to finish AI card")
            finally:
                await self._redis_cleanup()

    async def emit_error(
        self,
        task_id: Any,
        subtask_id: int,
        error: str,
        **kwargs: Any,
    ) -> None:
        async with self._update_lock:
            if self._finished:
                return
            logger.warning(
                "[StreamingEmitter] error task=%s subtask=%s error=%s",
                task_id,
                subtask_id,
                mask_string(error),
            )
            try:
                if await self._ensure_card_started():
                    self._card.ai_fail()
                    self._finished = True
            except Exception:
                logger.exception("[StreamingEmitter] Failed to mark AI card failed")
            finally:
                await self._redis_cleanup()

    async def emit_cancelled(
        self,
        task_id: Any,
        subtask_id: int,
        **kwargs: Any,
    ) -> None:
        async with self._update_lock:
            if self._finished:
                return
            try:
                if not await self._ensure_card_started():
                    return
                answer = (await self._current_answer()).rstrip()
                content = f"{answer}\n\n⚠️ 任务已取消" if answer else "⚠️ 任务已取消"
                content = self._truncate_final(content)
                self._card.ai_streaming(content, append=False)
                await asyncio.sleep(0.1)
                self._card.ai_finish(content)
                self._finished = True
            except Exception:
                logger.exception("[StreamingEmitter] Failed to cancel AI card")
            finally:
                await self._redis_cleanup()

    async def close(self) -> None:
        if self._shared_content_key and not self._finished:
            await self._redis_cleanup()
