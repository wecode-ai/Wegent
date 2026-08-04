# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral external knowledge API schemas."""

from typing import Any, Literal, Mapping, Optional

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
    workspace_id: Optional[str] = None
    node_id: Optional[str] = None
    document_id: Optional[str] = None
    parent_id: Optional[str] = None
    target_name: Optional[str] = None
    boundBy: Optional[str] = None
    boundAt: Optional[str] = None

    @model_validator(mode="after")
    def validate_explicit_id(self):
        """Explicit external refs must identify a source."""
        if self.mode == "explicit" and not self.id:
            raise ValueError("id is required when mode is explicit")
        return self


def external_ref_canonical_key(
    ref: ExternalKnowledgeRef | Mapping[str, Any],
) -> str:
    """Return the full stable target key used across runtime and persistence."""
    value = ref.model_dump(exclude_none=True) if isinstance(ref, BaseModel) else ref
    parts = (
        value.get("provider"),
        value.get("mode"),
        value.get("id"),
        value.get("target_type") or "knowledge_base",
        value.get("workspace_id"),
        value.get("node_id"),
        value.get("document_id"),
    )
    return "external:" + ":".join("" if part is None else str(part) for part in parts)
