# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral external knowledge API schemas."""

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

ExternalKnowledgeBindingLevel = Literal["agent", "conversation"]


class ExternalKnowledgeRef(BaseModel):
    """Reference to an external knowledge source bound to a task."""

    provider: str = Field(..., min_length=1)
    mode: Literal["explicit", "all_accessible"] = "explicit"
    id: Optional[str] = None
    name: Optional[str] = None
    scope: Optional[str] = None
    target_type: Optional[Literal["knowledge_base", "folder", "document"]] = None
    node_id: Optional[str] = None
    document_id: Optional[str] = None
    parent_id: Optional[str] = None
    boundBy: Optional[str] = None
    boundAt: Optional[str] = None

    @model_validator(mode="after")
    def validate_explicit_id(self):
        """Explicit external refs must identify a source."""
        if self.mode == "explicit" and not self.id:
            raise ValueError("id is required when mode is explicit")
        return self
