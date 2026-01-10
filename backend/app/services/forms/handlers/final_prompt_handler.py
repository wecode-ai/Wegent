# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Final prompt form handler.

Handles the final prompt confirmation from clarification flow,
storing the prompt for task creation.
"""

import logging
from typing import Any, Dict

from app.services.forms.base_handler import (
    BaseFormHandler,
    FormContext,
    FormHandlerResult,
)
from app.services.forms.registry import form_handler

logger = logging.getLogger(__name__)


@form_handler("final_prompt")
class FinalPromptHandler(BaseFormHandler):
    """
    Handler for final prompt form submissions.

    Processes the confirmed/edited final prompt from the clarification
    flow for task creation.
    """

    async def validate(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Validate final prompt form data.

        Required fields:
        - final_prompt: The confirmed prompt text

        Args:
            form_data: Form data containing final_prompt
            context: Form context

        Returns:
            FormHandlerResult indicating validation success or failure
        """
        # Check required fields
        final_prompt = form_data.get("final_prompt")
        if not final_prompt:
            return FormHandlerResult.error(
                "final_prompt is required", error_code="MISSING_FINAL_PROMPT"
            )

        if not isinstance(final_prompt, str):
            return FormHandlerResult.error(
                "final_prompt must be a string", error_code="INVALID_PROMPT_TYPE"
            )

        if not final_prompt.strip():
            return FormHandlerResult.error(
                "final_prompt cannot be empty", error_code="EMPTY_PROMPT"
            )

        return FormHandlerResult.ok("Validation successful")

    async def process(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Process the final prompt submission.

        Returns the prompt for the frontend to store and use for task creation.

        Args:
            form_data: Validated form data
            context: Form context

        Returns:
            FormHandlerResult with processed prompt data
        """
        final_prompt = form_data.get("final_prompt", "").strip()

        # Optional: Store any additional context
        team_id = context.team_id or form_data.get("team_id")
        original_task_id = context.task_id

        return FormHandlerResult.ok(
            message="Final prompt confirmed",
            data={
                "final_prompt": final_prompt,
                "team_id": team_id,
                "original_task_id": original_task_id,
                "action": "create_task",  # Indicates next action for frontend
            },
        )
