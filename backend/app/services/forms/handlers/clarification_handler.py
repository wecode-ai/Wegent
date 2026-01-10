# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Clarification form handler.

Handles clarification question answers from users, formatting them as markdown
and sending them to the chat stream.
"""

import logging
from typing import Any, Dict, List, Optional

from app.services.forms.base_handler import (
    BaseFormHandler,
    FormContext,
    FormHandlerResult,
)
from app.services.forms.registry import form_handler

logger = logging.getLogger(__name__)


@form_handler("clarification")
class ClarificationHandler(BaseFormHandler):
    """
    Handler for clarification form submissions.

    Processes user answers to clarification questions and formats them
    as markdown for sending to the chat stream.
    """

    async def validate(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Validate clarification form data.

        Required fields:
        - answers: List of answer objects with question_id, question_text, answer_type, value

        Args:
            form_data: Form data containing answers
            context: Form context with task_id

        Returns:
            FormHandlerResult indicating validation success or failure
        """
        # Check required context
        if not context.task_id:
            return FormHandlerResult.error(
                "task_id is required in context", error_code="MISSING_TASK_ID"
            )

        # Check required fields
        answers = form_data.get("answers")
        if not answers:
            return FormHandlerResult.error(
                "answers field is required", error_code="MISSING_ANSWERS"
            )

        if not isinstance(answers, list):
            return FormHandlerResult.error(
                "answers must be a list", error_code="INVALID_ANSWERS_FORMAT"
            )

        # Validate each answer
        for i, answer in enumerate(answers):
            if not isinstance(answer, dict):
                return FormHandlerResult.error(
                    f"Answer at index {i} must be an object",
                    error_code="INVALID_ANSWER_FORMAT",
                )

            required_fields = ["question_id", "value"]
            for field in required_fields:
                if field not in answer:
                    return FormHandlerResult.error(
                        f"Answer at index {i} missing required field: {field}",
                        error_code="MISSING_ANSWER_FIELD",
                    )

            # Value should not be empty
            value = answer.get("value")
            if value is None or (isinstance(value, str) and not value.strip()):
                return FormHandlerResult.error(
                    f"Answer at index {i} has empty value",
                    error_code="EMPTY_ANSWER_VALUE",
                )
            if isinstance(value, list) and len(value) == 0:
                return FormHandlerResult.error(
                    f"Answer at index {i} has empty value list",
                    error_code="EMPTY_ANSWER_VALUE",
                )

        return FormHandlerResult.ok("Validation successful")

    async def process(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Process clarification answers by formatting as markdown.

        The formatted markdown will be returned in the result data
        for the caller to send via WebSocket.

        Args:
            form_data: Validated form data
            context: Form context

        Returns:
            FormHandlerResult with formatted_message in data
        """
        answers = form_data.get("answers", [])

        # Format answers as markdown
        formatted_message = self._format_answers_as_markdown(answers)

        return FormHandlerResult.ok(
            message="Clarification answers processed",
            data={
                "formatted_message": formatted_message,
                "task_id": context.task_id,
                "answer_count": len(answers),
            },
        )

    def _format_answers_as_markdown(self, answers: List[Dict[str, Any]]) -> str:
        """
        Format clarification answers as markdown.

        Matches the format used by the original ClarificationForm component.

        Args:
            answers: List of answer objects

        Returns:
            Formatted markdown string
        """
        lines = ["## My Answers\n"]

        for answer in answers:
            question_text = answer.get("question_text", "Question")
            answer_type = answer.get("answer_type", "choice")
            value = answer.get("value", "")
            selected_labels = answer.get("selected_labels")

            # Format the question
            lines.append(f"### {question_text}\n")

            # Format the answer based on type
            if answer_type == "custom":
                # Free text answer
                lines.append(f"{value}\n")
            else:
                # Choice answer - use labels if available
                if selected_labels:
                    if isinstance(selected_labels, list):
                        for label in selected_labels:
                            lines.append(f"- {label}")
                    else:
                        lines.append(f"- {selected_labels}")
                elif isinstance(value, list):
                    for v in value:
                        lines.append(f"- {v}")
                else:
                    lines.append(f"- {value}")

            lines.append("")  # Add blank line between answers

        return "\n".join(lines)
