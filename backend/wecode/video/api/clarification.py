# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Normalize clarification controls for the one-minute video workflow."""

import logging
from typing import Any

from app.db.session import SessionLocal
from app.models.task import TaskResource
from app.services.interactive_form_extensions import (
    register_interactive_form_question_normalizer,
)

logger = logging.getLogger(__name__)

ONE_MINUTE_VIDEO_TEAM_REF = {
    "name": "1分钟创意视频",
    "namespace": "default",
    "user_id": 0,
}

VIDEO_CHOICE_OPTIONS: dict[str, list[dict[str, Any]]] = {
    "duration": [
        {"label": "30秒", "value": "30"},
        {"label": "60秒", "value": "60", "recommended": True},
        {"label": "90秒", "value": "90"},
    ],
    "subtitle": [
        {"label": "需要", "value": "yes", "recommended": True},
        {"label": "不需要", "value": "no"},
    ],
    "narration": [
        {"label": "需要", "value": "yes", "recommended": True},
        {"label": "不需要", "value": "no"},
    ],
    "style": [
        {"label": "写实", "value": "realistic"},
        {"label": "动漫/卡通", "value": "anime"},
        {"label": "赛博朋克", "value": "cyberpunk"},
        {"label": "水墨/国风", "value": "ink_wash"},
        {"label": "电影感", "value": "cinematic", "recommended": True},
    ],
    "mood": [
        {"label": "温馨治愈", "value": "warm", "recommended": True},
        {"label": "悬疑紧张", "value": "tense"},
        {"label": "轻松愉快", "value": "cheerful"},
        {"label": "史诗震撼", "value": "epic"},
        {"label": "宁静悠远", "value": "peaceful"},
    ],
    "bgm": [
        {"label": "轻柔钢琴", "value": "piano", "recommended": True},
        {"label": "电子氛围", "value": "electronic"},
        {"label": "史诗交响", "value": "orchestral"},
        {"label": "民族/国风", "value": "ethnic"},
        {"label": "无背景音乐", "value": "none"},
    ],
}


def _is_one_minute_video_task(task_id: int) -> bool:
    """Return whether a task belongs to the public one-minute video team."""
    try:
        with SessionLocal() as db:
            task = db.get(TaskResource, task_id)
            if task is None or not isinstance(task.json, dict):
                return False
            spec = task.json.get("spec")
            if not isinstance(spec, dict):
                return False
            team_ref = spec.get("teamRef")
            if not isinstance(team_ref, dict):
                return False
            return all(
                team_ref.get(key) == value
                for key, value in ONE_MINUTE_VIDEO_TEAM_REF.items()
            )
    except Exception:
        logger.exception(
            "Failed to identify one-minute video task: task_id=%s", task_id
        )
        return False


def _as_question_dict(question: Any) -> dict[str, Any] | None:
    if isinstance(question, dict):
        return dict(question)
    model_dump = getattr(question, "model_dump", None)
    if callable(model_dump):
        value = model_dump()
        return value if isinstance(value, dict) else None
    return None


def _normalized_default(default: Any, options: list[dict[str, Any]]) -> list[str]:
    values = default if isinstance(default, list) else [default]
    allowed_values = {str(option["value"]) for option in options}
    labels_to_values = {
        str(option["label"]): str(option["value"]) for option in options
    }
    normalized = [
        labels_to_values.get(str(value), str(value))
        for value in values
        if value is not None
    ]
    selected = [value for value in normalized if value in allowed_values]
    if selected:
        return selected[:1]
    recommended = next(
        (str(option["value"]) for option in options if option.get("recommended")),
        str(options[0]["value"]),
    )
    return [recommended]


def normalize_one_minute_video_questions(questions: list[Any]) -> list[Any]:
    """Keep known video preferences as single-choice questions."""
    normalized_questions: list[Any] = []
    for question in questions:
        normalized = _as_question_dict(question)
        if normalized is None:
            normalized_questions.append(question)
            continue

        question_id = str(normalized.get("id") or "").strip().lower()
        fallback_options = VIDEO_CHOICE_OPTIONS.get(question_id)
        current_options = normalized.get("options")
        input_type = str(normalized.get("input_type") or "").strip().lower()
        already_choice = input_type in {
            "choice",
            "single_choice",
            "single_select",
            "select",
            "dropdown",
            "radio",
            "radio_group",
            "enum",
            "option",
        }
        if fallback_options and (not already_choice or not current_options):
            normalized["input_type"] = "choice"
            normalized["options"] = [dict(option) for option in fallback_options]
            normalized["multi_select"] = False
            normalized["placeholder"] = None

        normalized_options = normalized.get("options")
        if fallback_options and isinstance(normalized_options, list):
            normalized["default"] = _normalized_default(
                normalized.get("default"), normalized_options
            )

        normalized_questions.append(normalized)
    return normalized_questions


def normalize_video_clarification_questions(
    *, task_id: int, questions: list[Any]
) -> list[Any]:
    """Apply video-only form constraints without changing other agents."""
    if not _is_one_minute_video_task(task_id):
        return questions
    return normalize_one_minute_video_questions(questions)


def _normalize_registered_video_questions(
    task_id: int,
    questions: list[Any],
) -> list[Any]:
    return normalize_video_clarification_questions(
        task_id=task_id,
        questions=questions,
    )


register_interactive_form_question_normalizer(_normalize_registered_video_questions)
