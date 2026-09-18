# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Bounded, redacted progress state for DingTalk chat cards."""

import re
from dataclasses import dataclass, field
from typing import Any

from shared.utils.sensitive_data_masker import mask_string

_MARKDOWN_TOKEN_RE = re.compile(r"[`*_>#]+")
_CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]+")


def _safe_single_line(value: Any) -> str:
    """Return one masked, normalized line for the compact IM projection."""
    if not isinstance(value, str):
        return ""
    text = mask_string(value)
    text = _CONTROL_CHARACTER_RE.sub(" ", text)
    text = _MARKDOWN_TOKEN_RE.sub("", text)
    return " ".join(text.split()).strip()


def compact_text(value: Any, limit: int) -> str:
    """Return one safe, bounded line for the compact IM projection."""
    text = _safe_single_line(value)
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


@dataclass
class CompactProgressState:
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
    def from_dict(cls, value: Any) -> "CompactProgressState":
        if not isinstance(value, dict):
            return cls()
        mode = (
            value.get("mode")
            if value.get("mode") in {"progress", "answer"}
            else "progress"
        )
        current = compact_text(value.get("current"), cls.MAX_STEP_LENGTH)
        recent = value.get("recent") if isinstance(value.get("recent"), list) else []
        recent = [
            text
            for item in recent[-cls.MAX_RECENT :]
            if (text := compact_text(item, cls.MAX_STEP_LENGTH))
        ]
        blocks = value.get("blocks") if isinstance(value.get("blocks"), dict) else {}
        safe_blocks = {
            str(block_id): safe_block(block)
            for block_id, block in list(blocks.items())[-cls.MAX_BLOCKS :]
            if isinstance(block, dict)
        }
        reasoning_summary = compact_text(
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
        text = compact_text(value, self.MAX_STEP_LENGTH)
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
        text = compact_text(value, self.MAX_STEP_LENGTH)
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


def safe_block(block: Any) -> dict[str, Any]:
    """Keep only fields needed to project a block safely."""
    if not isinstance(block, dict):
        return {}
    block_type = compact_text(block.get("type"), 24).lower()
    safe = {
        "id": str(block.get("id") or "").strip(),
        "type": block_type,
        "status": compact_text(block.get("status"), 24).lower(),
        "process_kind": compact_text(block.get("process_kind"), 32).lower(),
        "tool_name": compact_text(block.get("tool_name"), 40),
        "display_name": compact_text(block.get("display_name"), 40),
        "title": compact_text(block.get("title"), 80),
        "agent_type": compact_text(block.get("agent_type"), 40),
    }
    if block_type in {"text", "plan"}:
        safe["content"] = compact_text(block.get("content"), 80)
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


def merge_safe_block(
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
    return safe_block(merged)


def _tool_label(value: dict[str, Any]) -> str:
    return value.get("display_name") or value.get("tool_name") or "工具"


def project_block(state: CompactProgressState, block: dict[str, Any]) -> None:
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
    state: CompactProgressState, block: dict[str, Any], status: str
) -> None:
    label = _tool_label(block)
    if status in {"error", "failed"}:
        state.set_current(f"工具执行失败：{label}")
    elif status in {"done", "completed", "success"}:
        state.complete(f"工具完成：{label}")
    else:
        state.set_current(f"正在使用工具：{label}")


def _project_subagent_block(
    state: CompactProgressState, block: dict[str, Any], status: str
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
    state: CompactProgressState, block: dict[str, Any], status: str
) -> None:
    content = block.get("content")
    if not content:
        state.set_current("正在整理过程…")
    elif status in {"done", "completed", "success"}:
        state.complete(content)
    else:
        state.set_current(content)
