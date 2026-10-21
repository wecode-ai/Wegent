# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic import BaseModel, ConfigDict, Field


class LoopItemPosition(BaseModel):
    """Insert before a sibling, or append when the anchor is null."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    before_item_id: str | None = Field(alias="beforeItemId", max_length=64)
