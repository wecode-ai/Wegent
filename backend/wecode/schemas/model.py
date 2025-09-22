# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class ModelCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="模型名称，需全局唯一")
    config: Dict[str, Any] = Field(..., description="模型配置JSON")


class ModelUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100, description="新的模型名称（可选）")
    config: Optional[Dict[str, Any]] = Field(None, description="新的模型配置JSON（可选）")
    is_active: Optional[bool] = Field(None, description="是否启用（可选）")


class ModelOut(BaseModel):
    id: int
    name: str
    config: Dict[str, Any]
    is_active: bool