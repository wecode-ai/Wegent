# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schema definitions for AI correction feature.
"""

from typing import Optional

from pydantic import BaseModel, Field


class CorrectionItem(BaseModel):
    """A single correction item with issue and suggestion."""

    issue: str = Field(..., description="Description of the issue found")
    suggestion: str = Field(..., description="Suggested correction")


class CorrectionScores(BaseModel):
    """Evaluation scores for the AI response."""

    accuracy: int = Field(..., ge=1, le=10, description="Accuracy score (1-10)")
    logic: int = Field(..., ge=1, le=10, description="Logic score (1-10)")
    completeness: int = Field(..., ge=1, le=10, description="Completeness score (1-10)")


class CorrectionRequest(BaseModel):
    """Request body for AI correction."""

    task_id: int = Field(..., description="Task ID")
    message_id: int = Field(..., description="Message ID of the AI response to correct")
    original_question: str = Field(..., description="The user's original question")
    original_answer: str = Field(..., description="The AI's original answer")
    correction_model_id: str = Field(..., description="Model ID to use for correction")


class CorrectionResponse(BaseModel):
    """Response body for AI correction."""

    message_id: int = Field(..., description="Correction message ID")
    scores: CorrectionScores = Field(..., description="Evaluation scores")
    corrections: list[CorrectionItem] = Field(
        default_factory=list, description="List of corrections"
    )
    summary: str = Field(..., description="Summary evaluation")
    improved_answer: str = Field(
        default="", description="Improved answer if corrections needed"
    )
    is_correct: bool = Field(default=False, description="True if no corrections needed")


class CorrectionStreamChunk(BaseModel):
    """Streaming chunk for correction response."""

    content: Optional[str] = None
    done: bool = False
    result: Optional[CorrectionResponse] = None
    error: Optional[str] = None
