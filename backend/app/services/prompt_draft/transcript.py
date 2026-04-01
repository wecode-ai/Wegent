# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole


def _extract_text_blocks(content: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(content, str):
        normalized = content.strip()
        if normalized:
            texts.append(normalized)
        return texts
    if not isinstance(content, list):
        return texts
    for block in content:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str):
            normalized = text.strip()
            if normalized:
                texts.append(normalized)
    return texts


def _parse_tool_arguments(raw_arguments: Any) -> dict[str, Any]:
    if not isinstance(raw_arguments, str) or not raw_arguments.strip():
        return {}
    try:
        parsed = json.loads(raw_arguments)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _summarize_tool_call(tool_call: dict[str, Any]) -> str | None:
    function = tool_call.get("function")
    if not isinstance(function, dict):
        return None
    name = str(function.get("name") or "").strip()
    if not name:
        return None

    arguments = _parse_tool_arguments(function.get("arguments"))
    if name == "load_skill":
        skill_name = str(arguments.get("skill_name") or "").strip()
        if skill_name:
            return f"尝试加载技能 {skill_name}"
        return "尝试加载技能"
    return f"尝试调用工具 {name}"


def _summarize_tool_result(message: dict[str, Any]) -> str | None:
    tool_name = str(message.get("name") or "").strip()
    content = str(message.get("content") or "").strip()
    if tool_name == "load_skill":
        match = re.search(r"Skill '([^']+)' has been loaded", content)
        if match:
            return f"已加载技能 {match.group(1)}"
        return "已执行技能加载"
    lowered = content.lower()
    if "error" in lowered or "failed" in lowered:
        shortened = content[:80]
        return f"工具 {tool_name or 'unknown'} 执行失败: {shortened}"
    return None


def extract_assistant_turn_blocks(result: Any) -> list[tuple[str, str]]:
    if isinstance(result, str):
        normalized = result.strip()
        return [("assistant", normalized)] if normalized else []

    if not isinstance(result, dict):
        return []

    blocks: list[tuple[str, str]] = []
    response_texts: list[str] = []
    attempt_notes: list[str] = []

    loaded_skills = result.get("loaded_skills")
    if isinstance(loaded_skills, list):
        for skill_name in loaded_skills:
            normalized = str(skill_name).strip()
            if normalized:
                attempt_notes.append(f"涉及技能 {normalized}")

    messages_chain = result.get("messages_chain")
    if isinstance(messages_chain, list) and messages_chain:
        for message in messages_chain:
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "assistant":
                for tool_call in message.get("tool_calls") or []:
                    if isinstance(tool_call, dict):
                        note = _summarize_tool_call(tool_call)
                        if note:
                            attempt_notes.append(note)
                response_texts.extend(_extract_text_blocks(message.get("content")))
            elif role == "tool":
                note = _summarize_tool_result(message)
                if note:
                    attempt_notes.append(note)

        if response_texts:
            blocks.append(("assistant", "\n".join(dict.fromkeys(response_texts))))
        if attempt_notes:
            blocks.append(
                ("assistant_attempt", "\n".join(dict.fromkeys(attempt_notes)))
            )
        if blocks:
            return blocks

    for key in ("value", "result", "content", "text", "answer"):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            blocks.append(("assistant", value.strip()))
            break
    return blocks


def collect_conversation_blocks(db: Session, task_id: int) -> list[tuple[str, str]]:
    subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id)
        .order_by(Subtask.created_at.asc(), Subtask.id.asc())
        .all()
    )

    blocks: list[tuple[str, str]] = []
    for subtask in subtasks:
        if subtask.role == SubtaskRole.USER and subtask.prompt:
            content = subtask.prompt.strip()
            if content:
                blocks.append(("user", content))
            continue

        if subtask.role == SubtaskRole.ASSISTANT:
            blocks.extend(extract_assistant_turn_blocks(subtask.result))

    return blocks
