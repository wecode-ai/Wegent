# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Literal, Optional

from pydantic import BaseModel


class PromptSource(BaseModel):
    """Source mapping for a piece of prompt content"""

    type: Literal["ghost", "member"]
    id: Optional[int] = None  # for ghost
    name: str  # ghost name or bot name
    field: Optional[str] = None  # "systemPrompt" for ghost
    content: str
    index: Optional[int] = None  # for member


class GetTeamPromptResponse(BaseModel):
    """Response for get_team_prompt"""

    assembled_prompt: str
    sources: List[PromptSource]


class PromptChange(BaseModel):
    """A single prompt change"""

    type: Literal["ghost", "member"]
    id: Optional[int] = None
    team_id: Optional[int] = None
    index: Optional[int] = None
    field: Optional[str] = None
    value: str


class ApplyPromptChangesRequest(BaseModel):
    """Request to apply prompt changes"""

    team_id: int
    changes: List[PromptChange]


class ApplyPromptChangesResponse(BaseModel):
    """Response after applying changes"""

    success: bool
    applied_changes: int
    errors: List[str] = []
