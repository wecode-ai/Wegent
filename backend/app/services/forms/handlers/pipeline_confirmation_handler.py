# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pipeline confirmation form handler.

Handles pipeline stage confirmation for multi-stage workflows.
"""

import logging
from typing import Any, Dict

from app.services.forms.base_handler import (
    BaseFormHandler,
    FormContext,
    FormHandlerResult,
)
from app.services.forms.registry import form_handler
from app.services.adapters.task_kinds import task_kinds_service

logger = logging.getLogger(__name__)


@form_handler("pipeline_confirmation")
class PipelineConfirmationHandler(BaseFormHandler):
    """
    Handler for pipeline stage confirmation submissions.

    Confirms a pipeline stage and proceeds to the next stage in
    multi-bot workflow execution.
    """

    async def validate(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Validate pipeline confirmation form data.

        Required:
        - context.task_id: Task ID for the pipeline
        - form_data.confirmed_prompt: The confirmed prompt text
        - form_data.action: Action to take (continue/retry)

        Args:
            form_data: Form data
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
        confirmed_prompt = form_data.get("confirmed_prompt")
        if confirmed_prompt is None:
            return FormHandlerResult.error(
                "confirmed_prompt is required", error_code="MISSING_CONFIRMED_PROMPT"
            )

        action = form_data.get("action", "continue")
        if action not in ["continue", "retry"]:
            return FormHandlerResult.error(
                f"Invalid action: {action}. Must be 'continue' or 'retry'",
                error_code="INVALID_ACTION",
            )

        return FormHandlerResult.ok("Validation successful")

    async def process(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Process pipeline stage confirmation.

        Calls the task_kinds_service to confirm the current stage
        and proceed to the next one.

        Args:
            form_data: Validated form data
            context: Form context

        Returns:
            FormHandlerResult with stage progression info
        """
        task_id = context.task_id
        confirmed_prompt = form_data.get("confirmed_prompt", "")
        action = form_data.get("action", "continue")

        try:
            # Call existing service method
            result = task_kinds_service.confirm_pipeline_stage(
                db=self.db,
                task_id=task_id,
                user_id=self.user_id,
                confirmed_prompt=confirmed_prompt,
                action=action,
            )

            return FormHandlerResult.ok(
                message="Pipeline stage confirmed",
                data={
                    "current_stage": result.current_stage,
                    "next_stage_name": result.next_stage_name,
                    "is_completed": result.is_completed,
                    "task_id": task_id,
                },
            )

        except ValueError as e:
            return FormHandlerResult.error(
                str(e), error_code="PIPELINE_CONFIRMATION_ERROR"
            )
        except Exception as e:
            logger.exception(f"Error confirming pipeline stage for task {task_id}")
            return FormHandlerResult.error(
                f"Failed to confirm pipeline stage: {str(e)}",
                error_code="PIPELINE_ERROR",
            )
