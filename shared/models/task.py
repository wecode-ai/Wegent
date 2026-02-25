# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Legacy task models - kept for backward compatibility.

Note: These models are used by executor agents for progress reporting.
For new code, prefer using ExecutionRequest and ExecutionEvent from
shared.models.execution module.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ThinkingStep(BaseModel):
    """Thinking step model for recording agent reasoning process"""

    title: str = Field(..., description="Title of thinking step")
    next_action: str = Field(default="continue", description="Next action to take")
    details: Optional[Dict[str, Any]] = Field(
        default=None, description="Detailed structured data for this step"
    )
    run_id: Optional[str] = Field(
        default=None,
        description="LangChain run_id for matching tool start/end (legacy)",
    )
    tool_use_id: Optional[str] = Field(
        default=None, description="Anthropic tool_use_id (standard identifier)"
    )

    def dict(self, **kwargs) -> Dict[str, Any]:
        """Override dict method to exclude None values"""
        # Exclude None values by default
        kwargs.setdefault("exclude_none", True)
        return super().dict(**kwargs)


class ExecutionResult(BaseModel):
    """Execution result model for agent progress reporting.

    Used by executor agents to report execution results including
    the final value and thinking steps.
    """

    value: Optional[str] = None
    thinking: List[ThinkingStep] = []
    reasoning_content: Optional[str] = None  # Reasoning content from DeepSeek R1 etc.

    def dict(self, **kwargs) -> Dict[str, Any]:
        """Override dict method to exclude None values"""
        # Exclude None values by default
        kwargs.setdefault("exclude_none", True)
        return super().dict(**kwargs)
