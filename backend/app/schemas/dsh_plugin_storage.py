# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for generic DSH plugin storage."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DshStorageDescriptor(BaseModel):
    version: int = Field(ge=0)
    tables: List[str] = Field(default_factory=list, max_length=64)
    has_global: bool = False


class DshStorageRecordWrite(DshStorageDescriptor):
    value: Any
    shared: bool = False


class DshStorageGlobalWrite(DshStorageDescriptor):
    value: Any


class DshStorageSnapshot(BaseModel):
    version: int
    tables: Dict[str, Dict[str, Any]]
    global_value: Optional[Any] = Field(default=None, alias="global")

    model_config = {"populate_by_name": True}


class DshSharedStorageRecord(BaseModel):
    owner_id: int
    owner_name: str
    key: str
    value: Any


class DshSharedStorageResponse(BaseModel):
    records: List[DshSharedStorageRecord]
