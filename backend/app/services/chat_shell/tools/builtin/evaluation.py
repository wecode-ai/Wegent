# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Evaluation tool for AI response correction service.

This tool is used to submit structured evaluation results when analyzing
AI responses. It enforces a strict schema for evaluation data.
"""

from typing import Literal

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class IssueItem(BaseModel):
    """A single issue found in the AI response."""

    severity: Literal["critical", "major", "minor"] = Field(
        description="Critical=Fact error/Safety; Major=Missing key info; Minor=Style/Nitpick"
    )
    category: Literal["fact_error", "logic_error", "omission", "style", "safety"] = (
        Field(description="Problem category")
    )
    description: str = Field(
        description="Brief description of the issue. MUST be in the SAME language as detected_language"
    )
    suggestion: str = Field(
        description="Actionable fix. MUST be in the SAME language as detected_language"
    )


class EvaluationMeta(BaseModel):
    """Metadata about the evaluation."""

    detected_language: str = Field(
        description="ISO language code detected from User Question (e.g., 'zh-CN', 'en-US')"
    )


class EvaluationScores(BaseModel):
    """Evaluation scores for the AI response."""

    accuracy: int = Field(ge=1, le=10, description="Factuality score (1-10)")
    completeness: int = Field(
        ge=1, le=10, description="Did it answer all parts? (1-10)"
    )
    logic: int = Field(ge=1, le=10, description="Reasoning and consistency (1-10)")


class SubmitEvaluationInput(BaseModel):
    """Input schema for submitting evaluation results."""

    meta: EvaluationMeta
    scores: EvaluationScores
    is_pass: bool = Field(
        description="Set to false if there are critical factual errors, safety issues, or major logic flaws. Set to true if only minor style tweaks are needed."
    )
    issues: list[IssueItem] = Field(
        default_factory=list,
        description="List of specific problems found. Empty if perfect.",
    )
    summary: str = Field(
        description="A 2-3 sentence summary of why the user might be dissatisfied. MUST be in the SAME language as 'detected_language'."
    )
    improved_answer: str = Field(
        description="The corrected, complete answer. RULES: 1. Must match 'detected_language'. 2. Must fix all identified issues. 3. Must RETAIN all correct details from the original (Superset Rule) - DO NOT summarize."
    )


class SubmitEvaluationResultTool(BaseTool):
    """Tool for submitting structured evaluation results.

    This tool is designed to be used with tool_choice to force the model
    to return structured evaluation data instead of free-form text.
    """

    name: str = "submit_evaluation_result"
    display_name: str = "正在提交评估结果"
    description: str = (
        "Submit the evaluation critique and correction for an AI response. "
        "This function MUST be called to return the final analysis."
    )
    args_schema: type[BaseModel] = SubmitEvaluationInput

    def _run(
        self,
        meta: dict,
        scores: dict,
        is_pass: bool,
        issues: list[dict],
        summary: str,
        improved_answer: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous execution - not used in practice."""
        return "Evaluation submitted successfully"

    async def _arun(
        self,
        meta: dict,
        scores: dict,
        is_pass: bool,
        issues: list[dict],
        summary: str,
        improved_answer: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Asynchronous execution - not used in practice."""
        return "Evaluation submitted successfully"
