# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Form-related schemas for MCP interactive tools.
"""

from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class FieldOption(BaseModel):
    """Option for choice fields."""

    value: str = Field(..., description="Option value")
    label: str = Field(..., description="Display label for the option")
    recommended: bool = Field(False, description="Whether this is a recommended option")


class FieldValidation(BaseModel):
    """Validation rules for form fields."""

    required: bool = Field(False, description="Whether this field is required")
    min_length: Optional[int] = Field(None, description="Minimum length for text fields")
    max_length: Optional[int] = Field(None, description="Maximum length for text fields")
    min: Optional[float] = Field(None, description="Minimum value for number fields")
    max: Optional[float] = Field(None, description="Maximum value for number fields")
    pattern: Optional[str] = Field(None, description="Regular expression pattern")
    pattern_message: Optional[str] = Field(
        None, description="Error message when pattern doesn't match"
    )


class ShowCondition(BaseModel):
    """Conditional display rule for form fields."""

    field_id: str = Field(..., description="ID of the field to depend on")
    operator: Literal["equals", "not_equals", "contains", "in"] = Field(
        ..., description="Comparison operator"
    )
    value: Any = Field(..., description="Value to compare against")


class FormField(BaseModel):
    """Definition of a form field."""

    field_id: str = Field(..., description="Unique field identifier")
    field_type: Literal[
        "text",
        "textarea",
        "number",
        "single_choice",
        "multiple_choice",
        "datetime",
    ] = Field(..., description="Type of the form field")
    label: str = Field(..., description="Field label")
    placeholder: Optional[str] = Field(None, description="Placeholder text")
    default_value: Optional[Any] = Field(None, description="Default value")
    options: Optional[List[FieldOption]] = Field(
        None, description="Options for choice fields (required for single_choice/multiple_choice)"
    )
    validation: Optional[FieldValidation] = Field(None, description="Validation rules")
    show_when: Optional[ShowCondition] = Field(None, description="Conditional display rule")

    @model_validator(mode="after")
    def validate_options_for_choice_fields(self) -> "FormField":
        """Validate that choice fields have options defined."""
        choice_types = ("single_choice", "multiple_choice")
        if self.field_type in choice_types:
            if not self.options or len(self.options) == 0:
                raise ValueError(
                    f"Field '{self.field_id}' of type '{self.field_type}' requires non-empty options list"
                )
        return self


class SendFormInput(BaseModel):
    """Input parameters for send_form tool."""

    title: str = Field(..., description="Form title")
    description: Optional[str] = Field(None, description="Form description")
    fields: List[FormField] = Field(..., description="Form field definitions")
    submit_button_text: str = Field("Submit", description="Submit button text")


class SendFormResult(BaseModel):
    """Result from send_form tool."""

    success: bool = Field(..., description="Whether the form was sent successfully")
    form_id: str = Field(..., description="Unique identifier for the form")
    error: Optional[str] = Field(None, description="Error message if failed")


class SelectOption(BaseModel):
    """Option for selection dialogs."""

    value: str = Field(..., description="Option value")
    label: str = Field(..., description="Display label")
    description: Optional[str] = Field(None, description="Optional description")
    recommended: bool = Field(False, description="Whether this is a recommended option")


class SendConfirmInput(BaseModel):
    """Input parameters for send_confirm tool."""

    title: str = Field(..., description="Confirmation dialog title")
    message: str = Field(..., description="Confirmation message (supports Markdown)")
    confirm_text: str = Field("Confirm", description="Confirm button text")
    cancel_text: str = Field("Cancel", description="Cancel button text")


class SendConfirmResult(BaseModel):
    """Result from send_confirm tool."""

    success: bool = Field(..., description="Whether the confirmation was sent successfully")
    confirm_id: str = Field(..., description="Unique identifier for the confirmation")
    error: Optional[str] = Field(None, description="Error message if failed")


class SendSelectInput(BaseModel):
    """Input parameters for send_select tool."""

    title: str = Field(..., description="Selection dialog title")
    options: List[SelectOption] = Field(..., description="Selection options")
    multiple: bool = Field(False, description="Whether multiple selection is allowed")
    description: Optional[str] = Field(None, description="Optional description")


class SendSelectResult(BaseModel):
    """Result from send_select tool."""

    success: bool = Field(..., description="Whether the selection was sent successfully")
    select_id: str = Field(..., description="Unique identifier for the selection")
    error: Optional[str] = Field(None, description="Error message if failed")
