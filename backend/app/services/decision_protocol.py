# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Translate the stable SystemOne-shaped workbench contract at the provider edge."""

import json
import math
from typing import Any

from app.schemas.decision import DecisionQuestion, DecisionRequest


def _text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _openai_question(name: str, question: DecisionQuestion) -> dict[str, Any]:
    instructions = question.instructions
    if question.type == "noul" and question.criteria:
        instructions = {"instructions": instructions, "criteria": question.criteria}
    result: dict[str, Any] = {
        "name": name,
        "type": "predicate" if question.type == "noul" else question.type,
        "instructions": _text(instructions),
    }
    if question.type == "choice":
        result["choices"] = [
            {"value": value, "description": "" if rubric is None else _text(rubric)}
            for value, rubric in question.criteria.items()
        ]
    elif question.type == "score":
        result["levels"] = [
            {"label": str(index), "description": _text(rubric)}
            for index, rubric in enumerate(question.criteria)
        ]
    return result


def build_decision_payload(
    request: DecisionRequest, protocol: str, model_id: str
) -> dict[str, Any]:
    if protocol == "systemone":
        return {
            "model": model_id,
            "state": request.state,
            "questions": {
                name: question.model_dump(exclude_none=True)
                for name, question in request.questions.items()
            },
        }
    if protocol != "openai":
        raise ValueError("Unsupported decision protocol")
    return {
        "model": model_id,
        "input": _text(request.state),
        "questions": [
            _openai_question(name, question)
            for name, question in request.questions.items()
        ],
    }


def _number(value: Any, minimum: float, maximum: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise ValueError("Invalid decision answer number")
    return value


def _probabilities(answer: dict, protocol: str, choices: list[str]) -> dict[str, float]:
    values = answer.get("probabilities")
    if protocol == "openai":
        if not isinstance(values, list):
            raise ValueError("Invalid decision probabilities")
        mapped = {}
        for item in values:
            if not isinstance(item, dict):
                raise ValueError("Invalid decision probability entry")
            key = str(item.get("value"))
            if key in mapped:
                raise ValueError("Duplicate decision probability")
            mapped[key] = item.get("probability")
        values = mapped
    if not isinstance(values, dict) or set(values) != set(choices):
        raise ValueError("Invalid decision probability options")
    result = {key: _number(values[key], 0, 1) for key in choices}
    if not math.isclose(sum(result.values()), 1, abs_tol=0.02):
        raise ValueError("Decision probabilities must sum to one")
    return result


def _normalize_answer(
    answer: Any, question: DecisionQuestion, protocol: str
) -> dict[str, Any]:
    if not isinstance(answer, dict):
        raise ValueError("Invalid decision answer")
    if protocol == "openai" and answer.get("type") == "refusal":
        return {"type": "refusal"}
    expected_type = (
        "predicate"
        if protocol == "openai" and question.type == "noul"
        else question.type
    )
    if answer.get("type") != expected_type:
        raise ValueError("Decision answer type does not match the question")
    if question.type == "noul":
        field = "probability" if protocol == "openai" else "noul"
        return {"type": "noul", "noul": _number(answer.get(field), 0, 1)}
    choices = (
        list(question.criteria)
        if question.type == "choice"
        else [str(index) for index in range(len(question.criteria))]
    )
    result = {
        "type": question.type,
        "confidence": _number(answer.get("confidence"), 0, 1),
        "probabilities": _probabilities(answer, protocol, choices),
    }
    if question.type == "choice":
        if answer.get("choice") not in choices:
            raise ValueError("Invalid decision choice")
        result["choice"] = answer["choice"]
    else:
        result["score"] = _number(answer.get("score"), 0, len(choices) - 1)
        result["legend"] = {
            str(index): _text(rubric) for index, rubric in enumerate(question.criteria)
        }
    return result


def normalize_decision_response(
    value: Any, request: DecisionRequest, protocol: str
) -> dict[str, Any]:
    """Rebuild every response field; provider debug and unknown fields never pass."""
    if not isinstance(value, dict):
        raise ValueError("Invalid decision response")
    answers = value.get("answers")
    if protocol == "openai":
        if not isinstance(answers, list):
            raise ValueError("Invalid decision answers")
        mapped = {}
        for answer in answers:
            if not isinstance(answer, dict) or not isinstance(answer.get("name"), str):
                raise ValueError("Invalid named decision answer")
            name = answer["name"]
            if name in mapped:
                raise ValueError("Duplicate decision answer")
            mapped[name] = answer
        answers = mapped
    if not isinstance(answers, dict) or set(answers) != set(request.questions):
        raise ValueError("Decision answers must match the requested questions")
    result: dict[str, Any] = {
        "model": request.model,
        "answers": {
            name: _normalize_answer(answers[name], question, protocol)
            for name, question in request.questions.items()
        },
    }
    usage = value.get("usage")
    if isinstance(usage, dict):
        result["usage"] = {
            key: count
            for key in ("input_tokens", "output_tokens", "total_tokens")
            if isinstance(count := usage.get(key), int)
            and not isinstance(count, bool)
            and count >= 0
        }
    return result
