# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for the evaluation module API.

This module defines request/response schemas for:
- Topics: Examination subjects/categories
- Questions: Individual examination questions
- Answers: User submissions
- Grading Tasks: AI-powered grading operations
- Permissions: Access control for private topics
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# ============================================================================
# Multi-Model Grading Configuration Schemas (defined first to avoid forward references)
# ============================================================================


class ScorerModelConfig(BaseModel):
    """Configuration for a single scorer model in multi-model grading."""

    model_id: str = Field(..., description="Model ID for scoring")
    force_override: bool = Field(
        True, description="Whether to force override bot's model"
    )


class AggregatorModelConfig(BaseModel):
    """Configuration for the aggregator model in multi-model grading."""

    model_id: str = Field(..., description="Model ID for aggregation")
    force_override: bool = Field(
        True, description="Whether to force override bot's model"
    )


class MultiModelGradingConfig(BaseModel):
    """Configuration for multi-model grading."""

    scorer_team_id: int = Field(..., description="Team ID for scorer models")
    aggregator_team_id: int = Field(..., description="Team ID for aggregator model")
    scorer_models: List[ScorerModelConfig] = Field(
        ..., description="List of scorer model configurations"
    )
    aggregator_model: AggregatorModelConfig = Field(
        ..., description="Aggregator model configuration"
    )
    scorer_prompt_template: Optional[str] = Field(
        None, description="Prompt template for scorer models"
    )
    aggregator_prompt_template: Optional[str] = Field(
        None, description="Prompt template for aggregator model"
    )


# ============================================================================
# Topic Schemas
# ============================================================================


class TopicBase(BaseModel):
    """Base schema for topic data."""

    name: str = Field(..., min_length=1, max_length=200, description="Topic name")
    description: Optional[str] = Field(
        None, max_length=2000, description="Topic description"
    )
    visibility: str = Field("private", description="Visibility: 'public' or 'private'")


class TopicCreate(TopicBase):
    """Schema for creating a new topic."""

    grading_team_id: Optional[int] = Field(
        None, description="Team ID for AI grading (optional)"
    )
    instructions: Optional[str] = Field(
        None,
        max_length=10000,
        description="Exam instructions in Markdown format",
    )


class TopicUpdate(BaseModel):
    """Schema for updating a topic."""

    name: Optional[str] = Field(None, min_length=1, max_length=200)
    visibility: Optional[str] = Field(None)
    grading_team_id: Optional[int] = Field(None)
    extra_data: Optional[Dict[str, Any]] = Field(
        None,
        description="Extra data: {description, instructions, duration: {intro, exam, review}, video}",
    )


class TopicInDB(TopicBase):
    """Schema for topic data from database."""

    id: int
    creator_id: int
    status: int = Field(description="Status: 0=draft, 1=published")
    current_version: str
    extra_data: Dict[str, Any] = Field(default_factory=dict)
    grading_team_config: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    is_active: bool = True

    # Additional computed fields
    question_count: Optional[int] = Field(None, description="Number of questions")
    published_question_count: Optional[int] = Field(
        None, description="Number of published questions"
    )
    creator_name: Optional[str] = Field(None, description="Creator username")

    class Config:
        from_attributes = True


class TopicListResponse(BaseModel):
    """Paginated list response for topics."""

    total: int
    items: List[TopicInDB]


class TopicVersionInDB(BaseModel):
    """Schema for topic version data."""

    id: int
    topic_id: int
    version: str
    question_snapshots: List[Dict[str, Any]]
    published_at: datetime
    published_by: int

    class Config:
        from_attributes = True


class TopicVersionListResponse(BaseModel):
    """Paginated list response for topic versions."""

    total: int
    items: List[TopicVersionInDB]


# ============================================================================
# Question Schemas
# ============================================================================


class QuestionBase(BaseModel):
    """Base schema for question data."""

    title: str = Field(..., min_length=1, max_length=500, description="Question title")
    content_type: str = Field(
        "text", description="Content type: text/url/attachment/mixed"
    )
    content_data: Dict[str, Any] = Field(
        default_factory=dict, description="Question content data"
    )
    order_index: Optional[int] = Field(0, description="Sort order")


class QuestionCreate(QuestionBase):
    """Schema for creating a new question.

    Note: content_type and criteria_type are independent.
    For example, question content can be text while criteria can be attachments.

    content_data and criteria_data structure:
    {
        "text": "...",                        # For text type
        "url": "https://...",                 # For URL type
        "attachments": [                      # For attachment type
            {"key": "s3_key", "filename": "...", "size": 123}
        ]
    }
    """

    criteria_type: Optional[str] = Field(
        "text",
        description="Criteria content type: text/url/attachment/mixed (independent from content)",
    )
    criteria_data: Optional[Dict[str, Any]] = Field(
        default_factory=dict, description="Grading criteria (draft)"
    )


class QuestionUpdate(BaseModel):
    """Schema for updating a question.

    Note: content_type and criteria_type are independent.
    """

    title: Optional[str] = Field(None, min_length=1, max_length=500)
    content_type: Optional[str] = Field(None)
    content_data: Optional[Dict[str, Any]] = Field(None)
    criteria_type: Optional[str] = Field(
        None,
        description="Criteria content type: text/url/attachment/mixed",
    )
    criteria_data: Optional[Dict[str, Any]] = Field(None)
    order_index: Optional[int] = Field(None)


class QuestionInDB(QuestionBase):
    """Schema for question data from database."""

    id: int
    topic_id: int
    status: int = Field(description="Status: 0=draft, 1=published")
    current_version: str
    creator_id: int
    created_at: datetime
    updated_at: datetime
    is_active: bool = True

    # Optional criteria data (for graders/creators)
    criteria_type: Optional[str] = Field(
        None, description="Criteria content type: text/url/attachment/mixed"
    )
    criteria_data: Optional[Dict[str, Any]] = Field(None)

    # Version info
    has_new_version: Optional[bool] = Field(
        None, description="Whether a newer version exists"
    )
    latest_version: Optional[str] = Field(None, description="Latest published version")

    class Config:
        from_attributes = True


class QuestionListResponse(BaseModel):
    """Paginated list response for questions."""

    total: int
    items: List[QuestionInDB]


class QuestionVersionInDB(BaseModel):
    """Schema for question version data."""

    id: int
    question_id: int
    version: str
    content_data: Dict[str, Any]
    criteria_data: Dict[str, Any]
    published_at: datetime
    published_by: int

    class Config:
        from_attributes = True


class QuestionVersionListResponse(BaseModel):
    """Paginated list response for question versions."""

    total: int
    items: List[QuestionVersionInDB]


# ============================================================================
# Permission Schemas
# ============================================================================


class PermissionCreate(BaseModel):
    """Schema for creating a permission."""

    user_id: int = Field(..., description="User ID to grant permission")
    role: str = Field("respondent", description="Role: 'respondent' or 'grader'")


class PermissionInDB(BaseModel):
    """Schema for permission data from database."""

    id: int
    topic_id: int
    user_id: int
    role: str
    granted_by: int
    granted_at: datetime

    # Optional user info
    user_name: Optional[str] = Field(None, description="Username")
    user_email: Optional[str] = Field(None, description="User email")

    class Config:
        from_attributes = True


class PermissionListResponse(BaseModel):
    """List response for permissions."""

    total: int
    items: List[PermissionInDB]


# ============================================================================
# Answer Schemas
# ============================================================================


class AnswerCreate(BaseModel):
    """Schema for creating/submitting an answer.

    Supports multiple content types:
    - text: Use content_text field for text content
    - url: Use content_data.url for URL link
    - attachment: Use content_data.attachments for file attachments
    - mixed: Combine multiple content types

    content_data structure:
    {
        "text": "...",                        # For text content (or use content_text)
        "url": "https://...",                 # For URL link
        "attachments": [                      # For file attachments
            {"key": "s3_key", "filename": "...", "size": 123, "content_type": "..."}
        ]
    }
    """

    content_type: str = Field(
        "text", description="Content type: text/url/attachment/mixed"
    )
    content_text: Optional[str] = Field(
        None, description="Text content (convenience field)"
    )
    content_data: Optional[Dict[str, Any]] = Field(
        default_factory=dict,
        description="Content data including URL, attachments, or any additional metadata",
    )


class AnswerInDB(BaseModel):
    """Schema for answer data from database."""

    id: int
    question_id: int
    question_version: str
    respondent_id: int
    content_type: str
    content_data: Dict[str, Any]
    submitted_at: datetime
    is_latest: bool

    # Optional respondent info
    respondent_name: Optional[str] = Field(None, description="Respondent username")

    # Optional grading info
    grading_status: Optional[int] = Field(
        None, description="Latest grading task status"
    )
    grading_task_id: Optional[int] = Field(None, description="Latest grading task ID")

    class Config:
        from_attributes = True


class AnswerListResponse(BaseModel):
    """Paginated list response for answers."""

    total: int
    items: List[AnswerInDB]


# ============================================================================
# Grading Task Schemas
# ============================================================================


class GradingTaskInDB(BaseModel):
    """Schema for grading task data from database."""

    id: int
    answer_id: int
    question_id: int
    question_version: str
    respondent_id: int
    grader_id: int
    team_id: int
    task_id: int
    status: int = Field(
        description="Status: 0=pending, 1=running, 2=completed, 3=failed, 4=published"
    )
    executor_id: Optional[str] = Field(None, description="Executor instance ID")
    attempt_count: Optional[int] = Field(0, description="Execution attempt count")
    error_message: Optional[str] = Field(None, description="Error message when failed")
    report_data: Dict[str, Any]
    report_s3_path: str
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    published_at: Optional[datetime]
    version: int = Field(1, description="Optimistic locking version for report editing")

    # Optional related info
    respondent_name: Optional[str] = Field(None)
    question_title: Optional[str] = Field(None)
    topic_id: Optional[int] = Field(None, description="Topic ID")
    topic_name: Optional[str] = Field(None, description="Topic name")

    # Answer submission time
    submitted_at: Optional[datetime] = Field(
        None, description="When the answer was submitted by the respondent"
    )

    # Grading mode: single or multi
    grading_mode: Optional[str] = Field(
        None, description="Grading mode: single or multi"
    )

    class Config:
        from_attributes = True


class GradingTaskListResponse(BaseModel):
    """Paginated list response for grading tasks."""

    total: int
    items: List[GradingTaskInDB]


class GradingTaskExecuteRequest(BaseModel):
    """Request schema for executing a grading task."""

    team_id: Optional[int] = Field(
        None, description="Override team ID (uses topic config if not specified)"
    )
    model_id: Optional[str] = Field(
        None, description="Optional model ID to override bot's default model"
    )
    force_override_bot_model: bool = Field(
        False, description="Whether to force override bot's model selection"
    )
    # Multi-model grading override fields
    grading_mode: Optional[str] = Field(
        None, description="Override grading mode: single or multi"
    )
    scorer_team_id: Optional[int] = Field(
        None, description="Override scorer team ID for multi-model grading"
    )
    aggregator_team_id: Optional[int] = Field(
        None, description="Override aggregator team ID for multi-model grading"
    )
    scorer_models: Optional[List[ScorerModelConfig]] = Field(
        None, description="Override scorer model configurations"
    )
    aggregator_model: Optional[AggregatorModelConfig] = Field(
        None, description="Override aggregator model configuration"
    )


class GradingTaskPublishRequest(BaseModel):
    """Request schema for publishing a grading report."""

    report_content: Optional[str] = Field(
        None, description="Updated report content (optional)"
    )


class GradingTaskUpdateReportRequest(BaseModel):
    """Request schema for updating a grading report before publishing."""

    report_content: str = Field(..., description="Updated report content in Markdown")
    version: int = Field(..., description="Current version for optimistic locking")


# ============================================================================
# Grading Configuration Schemas
# ============================================================================


class GradingConfigUpdate(BaseModel):
    """Schema for configuring grading bot for a topic.

    This configuration is set by the topic author and determines
    the default grading behavior for all answers in this topic.
    """

    # Legacy single-model fields (kept for backward compatibility)
    team_id: Optional[int] = Field(
        None, description="Team ID for AI grading (must be Chat shell type)"
    )
    auto_trigger: bool = Field(
        False,
        description="Whether to automatically trigger grading on answer submission",
    )
    trigger_condition: str = Field(
        "manual",
        description="Trigger condition: manual/on_submit/scheduled/auto_with_review",
    )
    grading_timeout: int = Field(
        3600, description="Grading timeout in seconds", ge=60, le=7200
    )
    prompt_template: Optional[str] = Field(
        None,
        description="Custom prompt template for grading. "
        "Available variables: {user_id}, {grading_task_id}, "
        "{topic_id}, {question_id}, {question_title}",
    )
    model_id: Optional[str] = Field(
        None, description="Optional model ID to override bot's default model"
    )
    force_override_bot_model: bool = Field(
        False, description="Whether to force override bot's model selection"
    )

    # New multi-model grading fields
    grading_mode: str = Field(
        "single", description="Grading mode: manual, single or multi"
    )
    scorer_team_id: Optional[int] = Field(
        None, description="Team ID for scorer models (multi-model mode)"
    )
    aggregator_team_id: Optional[int] = Field(
        None, description="Team ID for aggregator model (multi-model mode)"
    )
    scorer_models: List[ScorerModelConfig] = Field(
        default_factory=list,
        description="List of scorer model configurations (3-5 models)",
    )
    aggregator_model: Optional[AggregatorModelConfig] = Field(
        None, description="Aggregator model configuration"
    )
    scorer_prompt_template: Optional[str] = Field(
        None, description="Prompt template for scorer models"
    )
    aggregator_prompt_template: Optional[str] = Field(
        None, description="Prompt template for aggregator model"
    )


class GradingConfigResponse(GradingConfigUpdate):
    """Response schema for grading configuration."""

    team_name: Optional[str] = Field(None, description="Team name if configured")
    team_valid: bool = Field(
        True, description="Whether the configured team is valid and accessible"
    )


# ============================================================================
# Upload Schemas
# ============================================================================


class FileUploadResponse(BaseModel):
    """Response schema for file uploads."""

    key: str = Field(..., description="Storage key for the uploaded file")
    url: str = Field(..., description="Presigned URL for accessing the file")
    filename: str = Field(..., description="Original filename")
    size: int = Field(..., description="File size in bytes")
    content_type: str = Field(..., description="MIME type")


# ============================================================================
# Statistics Schemas
# ============================================================================


class TopicStatistics(BaseModel):
    """Statistics for a topic."""

    total_questions: int = 0
    published_questions: int = 0
    total_answers: int = 0
    total_respondents: int = 0
    grading_pending: int = 0
    grading_completed: int = 0
    grading_published: int = 0


class RespondentProgress(BaseModel):
    """Progress statistics for a respondent in a topic."""

    total_questions: int = Field(0, description="Total number of published questions")
    answered_questions: int = Field(0, description="Number of questions answered")
    published_reports: int = Field(0, description="Number of published grading reports")
    completion_rate: float = Field(0.0, description="Completion rate (0-1)")
