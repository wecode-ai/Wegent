# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class ContextLimitConfig(BaseModel):
    """Configuration for model context limit.

    Used to control how much of the conversation history is sent to the LLM.
    When the context exceeds the limit, older messages will be truncated.
    """

    max_context_tokens: Optional[int] = Field(
        None,
        alias="maxContextTokens",
        description="Maximum context tokens for the model. If not set, uses model-specific default.",
    )
    reserved_output_ratio: float = Field(
        0.2,
        alias="reservedOutputRatio",
        ge=0,
        le=1,
        description="Ratio of context tokens reserved for output (0-1). Default is 0.2 (20%).",
    )

    class Config:
        populate_by_name = True


class ModelBase(BaseModel):
    """Model base schema"""

    name: str
    config: dict[str, Any]
    is_active: bool = True


class ModelCreate(ModelBase):
    """Model creation schema"""

    pass


class ModelUpdate(BaseModel):
    """Model update schema"""

    name: Optional[str] = None
    config: Optional[dict[str, Any]] = None
    is_active: Optional[bool] = None


class ModelInDB(ModelBase):
    """Database model schema"""

    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ModelDetail(BaseModel):
    """Detailed model schema"""

    id: int
    name: str
    config: dict[str, Any]
    is_active: bool = True
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ModelListResponse(BaseModel):
    """Model paginated response schema"""

    total: int
    items: list[ModelInDB]


# ===== Bulk create schemas =====

from typing import Any, List, Optional

from pydantic import BaseModel


class ModelBulkCreateItem(BaseModel):
    """
    Bulk create item schema.
    Accepts 'env' to match request body, we will wrap it into {'env': ...} as Model.config.
    """

    name: str
    env: dict[str, Any]
    is_active: bool = True


class ModelBulkCreateResponse(BaseModel):
    """
    Bulk create response schema.
    """

    created: List["ModelInDB"]
    skipped: List[dict]
