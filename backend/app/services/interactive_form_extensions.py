# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Extension points for request-scoped interactive form normalization."""

from typing import Any, Callable

InteractiveFormQuestionNormalizer = Callable[[int, list[Any]], list[Any]]

_question_normalizers: list[InteractiveFormQuestionNormalizer] = []


def register_interactive_form_question_normalizer(
    normalizer: InteractiveFormQuestionNormalizer,
) -> None:
    """Register an interactive form question normalizer."""
    _question_normalizers.append(normalizer)


def normalize_interactive_form_questions(
    *,
    task_id: int,
    questions: list[Any],
) -> list[Any]:
    """Apply registered question normalizers in registration order."""
    normalized = questions
    for normalizer in _question_normalizers:
        normalized = normalizer(task_id, normalized)
    return normalized
