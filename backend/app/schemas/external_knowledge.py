# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral external knowledge API schemas."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

ExternalKnowledgeBindingLevel = Literal["agent", "conversation"]


class ExternalKnowledgeRef(BaseModel):
    """Reference to an external knowledge source bound to a task."""

    provider: str = Field(..., min_length=1)
    mode: Literal["explicit"] = "explicit"
    id: str = Field(..., min_length=1)
    name: Optional[str] = None
    scope: Optional[str] = None
    target_type: Optional[Literal["knowledge_base", "folder", "document"]] = None
    node_id: Optional[str] = None
    document_id: Optional[str] = None
    parent_id: Optional[str] = None
    target_name: Optional[str] = None
    resource_url: Optional[str] = None
    # Server-written credential owner for delegated wiki refs. The API layer
    # overwrites any client-supplied value; it never carries the key itself.
    bound_by_user_id: Optional[int] = Field(
        None, ge=1, description="User id whose wiki connection this ref delegates"
    )
    boundBy: Optional[str] = None
    boundAt: Optional[str] = None
