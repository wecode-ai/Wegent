# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base form handler class.

All form handlers should inherit from BaseFormHandler and implement
the validate and process methods.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session


@dataclass
class FormHandlerResult:
    """Result returned by form handler processing."""

    success: bool
    message: str = ""
    data: Optional[Dict[str, Any]] = None
    error_code: Optional[str] = None

    @classmethod
    def ok(cls, message: str = "Success", data: Optional[Dict[str, Any]] = None):
        """Create a successful result."""
        return cls(success=True, message=message, data=data)

    @classmethod
    def error(
        cls,
        message: str,
        error_code: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
    ):
        """Create an error result."""
        return cls(success=False, message=message, error_code=error_code, data=data)


@dataclass
class FormContext:
    """Context information for form processing."""

    task_id: Optional[int] = None
    subtask_id: Optional[int] = None
    message_id: Optional[int] = None
    team_id: Optional[int] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "FormContext":
        """Create FormContext from dictionary."""
        if not data:
            return cls()
        return cls(
            task_id=data.get("task_id"),
            subtask_id=data.get("subtask_id"),
            message_id=data.get("message_id"),
            team_id=data.get("team_id"),
            extra=data.get("extra", {}),
        )


class BaseFormHandler(ABC):
    """
    Abstract base class for form handlers.

    Each form handler implements validation and processing logic
    for a specific action_type.
    """

    def __init__(self, db: Session, user_id: int):
        """
        Initialize handler with database session and user ID.

        Args:
            db: SQLAlchemy database session
            user_id: ID of the user submitting the form
        """
        self.db = db
        self.user_id = user_id

    @abstractmethod
    async def validate(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Validate form data before processing.

        Args:
            form_data: Form field data submitted by the user
            context: Form submission context (task_id, etc.)

        Returns:
            FormHandlerResult indicating validation success or failure
        """
        pass

    @abstractmethod
    async def process(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Process the validated form submission.

        Args:
            form_data: Validated form field data
            context: Form submission context

        Returns:
            FormHandlerResult with processing outcome
        """
        pass

    async def execute(
        self, form_data: Dict[str, Any], context: FormContext
    ) -> FormHandlerResult:
        """
        Execute validation and processing in sequence.

        This is the main entry point for form handling.

        Args:
            form_data: Form field data
            context: Form submission context

        Returns:
            FormHandlerResult from validation or processing
        """
        # Validate first
        validation_result = await self.validate(form_data, context)
        if not validation_result.success:
            return validation_result

        # Then process
        return await self.process(form_data, context)
