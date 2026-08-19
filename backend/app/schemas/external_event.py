# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API schemas for external event subscriptions."""

from pydantic import BaseModel, ConfigDict, Field


class ExternalReferenceRegister(BaseModel):
    provider: str = Field(min_length=1, max_length=128)
    opaque_ref: str = Field(min_length=1, max_length=512)
    item_id: str = Field(min_length=1, max_length=64)
    automation_run_id: str = Field(min_length=1, max_length=64)


class ExternalReferenceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    binding_id: str
    provider: str
    opaque_ref: str
    task_id: str
    issue_id: str
    workflow_node_id: str
    compensated_event_count: int = 0
