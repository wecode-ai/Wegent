# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Form submission API schemas.

Pydantic models for form submission request/response validation.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ============================================================
# Enums
# ============================================================


class FormSubmissionStatusEnum(str, Enum):
    """Status of a form submission."""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    ERROR = "error"


class FormFieldType(str, Enum):
    """Types of form fields."""

    SINGLE_CHOICE = "single_choice"
    MULTIPLE_CHOICE = "multiple_choice"
    TEXT_INPUT = "text_input"
    DATETIME_PICKER = "datetime_picker"
    NUMBER_INPUT = "number_input"


# ============================================================
# Form Field Schemas
# ============================================================


class FormFieldOption(BaseModel):
    """Option for choice fields."""

    value: str = Field(..., description="Option value")
    label: str = Field(..., description="Display label")
    recommended: bool = Field(False, description="Whether this option is recommended")


class FormFieldValidation(BaseModel):
    """Validation rules for form fields."""

    min: Optional[float] = Field(None, description="Minimum value (for numbers)")
    max: Optional[float] = Field(None, description="Maximum value (for numbers)")
    pattern: Optional[str] = Field(None, description="Regex pattern for validation")
    message: Optional[str] = Field(None, description="Custom validation error message")


class FormFieldSchema(BaseModel):
    """Schema for a single form field."""

    field_id: str = Field(..., description="Unique field identifier")
    field_type: FormFieldType = Field(..., description="Type of form field")
    label: str = Field(..., description="Display label for the field")
    required: bool = Field(True, description="Whether the field is required")
    options: Optional[List[FormFieldOption]] = Field(
        None, description="Options for choice fields"
    )
    placeholder: Optional[str] = Field(None, description="Placeholder text")
    default_value: Optional[Any] = Field(None, description="Default value")
    validation: Optional[FormFieldValidation] = Field(
        None, description="Validation rules"
    )


class FormSchema(BaseModel):
    """Schema for a complete form."""

    action_type: str = Field(..., description="Form action type identifier")
    title: str = Field(..., description="Form title")
    description: Optional[str] = Field(None, description="Form description")
    fields: List[FormFieldSchema] = Field(..., description="Form fields")
    submit_label: str = Field("Submit", description="Submit button label")


# ============================================================
# Request/Response Schemas
# ============================================================


class FormContext(BaseModel):
    """Context information for form submission."""

    task_id: Optional[int] = Field(None, description="Associated task ID")
    subtask_id: Optional[int] = Field(None, description="Associated subtask ID")
    message_id: Optional[int] = Field(None, description="Associated message ID")
    team_id: Optional[int] = Field(None, description="Associated team ID")
    extra: Optional[Dict[str, Any]] = Field(
        None, description="Additional context data"
    )


class FormSubmissionRequest(BaseModel):
    """Request schema for form submission."""

    action_type: str = Field(
        ...,
        description="Form action type (clarification, final_prompt, pipeline_confirmation, etc.)",
    )
    form_data: Dict[str, Any] = Field(..., description="Form field data")
    context: FormContext = Field(
        default_factory=FormContext, description="Submission context"
    )


class FormSubmissionResponse(BaseModel):
    """Response schema for form submission."""

    submission_id: str = Field(..., description="Unique submission ID for tracking")
    status: FormSubmissionStatusEnum = Field(..., description="Processing status")
    message: str = Field(..., description="Status message")
    result: Optional[Dict[str, Any]] = Field(
        None, description="Processing result (if completed)"
    )


class FormSubmissionDetail(BaseModel):
    """Detailed form submission record."""

    id: str = Field(..., description="Submission ID")
    action_type: str = Field(..., description="Form action type")
    form_data: Dict[str, Any] = Field(..., description="Submitted form data")
    context: Optional[Dict[str, Any]] = Field(None, description="Submission context")
    status: FormSubmissionStatusEnum = Field(..., description="Processing status")
    result: Optional[Dict[str, Any]] = Field(None, description="Processing result")
    error_message: Optional[str] = Field(None, description="Error message if failed")
    created_at: datetime = Field(..., description="Submission timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    class Config:
        from_attributes = True


# ============================================================
# Clarification-specific schemas (for compatibility)
# ============================================================


class ClarificationAnswer(BaseModel):
    """Answer to a clarification question."""

    question_id: str = Field(..., description="Question identifier")
    question_text: Optional[str] = Field(None, description="Question text")
    answer_type: str = Field(
        "choice", description="Answer type: 'choice' or 'custom'"
    )
    value: Any = Field(..., description="Answer value (string or list)")
    selected_labels: Optional[Any] = Field(
        None, description="Selected option labels (for display)"
    )


class ClarificationFormData(BaseModel):
    """Form data for clarification submissions."""

    answers: List[ClarificationAnswer] = Field(
        ..., description="List of clarification answers"
    )


# ============================================================
# Pipeline confirmation schemas
# ============================================================


class PipelineConfirmationFormData(BaseModel):
    """Form data for pipeline confirmation."""

    confirmed_prompt: str = Field(..., description="Confirmed/edited prompt text")
    action: str = Field(
        "continue", description="Action to take: 'continue' or 'retry'"
    )


# ============================================================
# Final prompt schemas
# ============================================================


class FinalPromptFormData(BaseModel):
    """Form data for final prompt confirmation."""

    final_prompt: str = Field(..., description="Final prompt text")
    team_id: Optional[int] = Field(None, description="Target team ID for task creation")
