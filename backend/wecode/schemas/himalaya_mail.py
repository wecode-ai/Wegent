# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schemas for Himalaya mail configuration requests.
"""

from typing import Literal

from pydantic import BaseModel, Field


class HimalayaMailConfigRequest(BaseModel):
    """Request schema for generating a Himalaya config on a local device."""

    task_id: int = Field(
        ...,
        gt=0,
        description="Task ID whose skill workspace contains the Himalaya extension",
    )
    account_prefix: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Read-only mail account prefix, such as 'sifang'",
    )
    email_domain: Literal["@staff.sina.com.cn", "@staff.weibo.com"] = Field(
        ...,
        description="Selectable email domain suffix",
    )
    password: str = Field(
        ...,
        min_length=1,
        description="Mail password used to generate the local config",
    )


class HimalayaMailConfigResponse(BaseModel):
    """Response schema for Himalaya config generation."""

    success: bool = Field(..., description="Whether the config was generated")
    message: str = Field(..., description="Human-readable result message")
    account_name: str | None = Field(
        default=None,
        description="Generated Himalaya account name",
    )
    config_path: str | None = Field(
        default=None,
        description="Config file path on the local device",
    )
