# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Form submission service.

Orchestrates form validation, processing, and persistence.
"""

import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.form_submission import FormSubmission, FormSubmissionStatus
from app.services.forms.base_handler import FormContext, FormHandlerResult
from app.services.forms.registry import get_handler, is_action_type_registered

logger = logging.getLogger(__name__)


class FormSubmissionService:
    """Service for handling unified form submissions."""

    def __init__(self, db: Session):
        """
        Initialize the form submission service.

        Args:
            db: SQLAlchemy database session
        """
        self.db = db

    def create_submission(
        self,
        action_type: str,
        form_data: Dict[str, Any],
        context: Dict[str, Any],
        user_id: int,
    ) -> FormSubmission:
        """
        Create a new form submission record.

        Args:
            action_type: Type of form action
            form_data: Form field data
            context: Submission context
            user_id: ID of submitting user

        Returns:
            Created FormSubmission instance
        """
        submission = FormSubmission(
            id=str(uuid.uuid4()),
            action_type=action_type,
            form_data=form_data,
            context=context,
            status=FormSubmissionStatus.PENDING,
            user_id=user_id,
            task_id=context.get("task_id"),
        )
        self.db.add(submission)
        self.db.commit()
        self.db.refresh(submission)
        return submission

    def update_submission_status(
        self,
        submission_id: str,
        status: FormSubmissionStatus,
        result: Optional[Dict[str, Any]] = None,
        error_message: Optional[str] = None,
    ) -> Optional[FormSubmission]:
        """
        Update a submission's status and result.

        Args:
            submission_id: ID of the submission to update
            status: New status
            result: Processing result (if completed)
            error_message: Error message (if failed)

        Returns:
            Updated FormSubmission or None if not found
        """
        submission = (
            self.db.query(FormSubmission)
            .filter(FormSubmission.id == submission_id)
            .first()
        )
        if not submission:
            return None

        submission.status = status
        submission.updated_at = datetime.utcnow()

        if result is not None:
            submission.result = result
        if error_message is not None:
            submission.error_message = error_message

        self.db.commit()
        self.db.refresh(submission)
        return submission

    async def process_submission(
        self,
        submission_id: str,
        action_type: str,
        form_data: Dict[str, Any],
        context: Dict[str, Any],
        user_id: int,
    ) -> FormHandlerResult:
        """
        Process a form submission using the appropriate handler.

        Args:
            submission_id: ID of the submission record
            action_type: Type of form action
            form_data: Form field data
            context: Submission context
            user_id: ID of submitting user

        Returns:
            FormHandlerResult from the handler
        """
        # Update status to processing
        self.update_submission_status(submission_id, FormSubmissionStatus.PROCESSING)

        try:
            # Get handler class
            handler_class = get_handler(action_type)
            handler = handler_class(self.db, user_id)

            # Create context object
            form_context = FormContext.from_dict(context)

            # Execute handler
            result = await handler.execute(form_data, form_context)

            # Update submission with result
            if result.success:
                self.update_submission_status(
                    submission_id,
                    FormSubmissionStatus.COMPLETED,
                    result=result.data,
                )
            else:
                self.update_submission_status(
                    submission_id,
                    FormSubmissionStatus.ERROR,
                    error_message=result.message,
                    result={"error_code": result.error_code} if result.error_code else None,
                )

            return result

        except Exception as e:
            logger.exception(f"Error processing form submission {submission_id}")
            self.update_submission_status(
                submission_id,
                FormSubmissionStatus.ERROR,
                error_message=str(e),
            )
            return FormHandlerResult.error(str(e), error_code="PROCESSING_ERROR")

    def get_submission(self, submission_id: str) -> Optional[FormSubmission]:
        """
        Get a form submission by ID.

        Args:
            submission_id: ID of the submission

        Returns:
            FormSubmission or None if not found
        """
        return (
            self.db.query(FormSubmission)
            .filter(FormSubmission.id == submission_id)
            .first()
        )

    def get_user_submissions(
        self,
        user_id: int,
        action_type: Optional[str] = None,
        task_id: Optional[int] = None,
        limit: int = 20,
    ) -> list:
        """
        Get form submissions for a user.

        Args:
            user_id: User ID to filter by
            action_type: Optional action type filter
            task_id: Optional task ID filter
            limit: Maximum number of results

        Returns:
            List of FormSubmission instances
        """
        query = self.db.query(FormSubmission).filter(FormSubmission.user_id == user_id)

        if action_type:
            query = query.filter(FormSubmission.action_type == action_type)
        if task_id:
            query = query.filter(FormSubmission.task_id == task_id)

        return (
            query.order_by(FormSubmission.created_at.desc())
            .limit(limit)
            .all()
        )


# Singleton instance for convenience
form_submission_service: Optional[FormSubmissionService] = None


def get_form_submission_service(db: Session) -> FormSubmissionService:
    """
    Get or create form submission service instance.

    Args:
        db: Database session

    Returns:
        FormSubmissionService instance
    """
    return FormSubmissionService(db)
