# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Domain-level retrieval scope contract shared by Backend and runtime."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RetrievalScope(BaseModel):
    """Domain-level retrieval scope.

    This is intentionally minimal for now. Document IDs are business document
    IDs and must be compiled by storage backends into their native doc_ref
    filters instead of being represented as generic metadata conditions.
    """

    model_config = ConfigDict(extra="forbid")

    document_ids: list[int] | None = None
    # Runtime supplies this from persisted publication state, never from a caller.
    published_versions: dict[int, int] = Field(default_factory=dict, exclude=True)

    def document_refs(self) -> list[str]:
        """Compile paired document/version identities before native top-k."""
        return [
            (
                f"{doc_id}@{self.published_versions[doc_id]}"
                if doc_id in self.published_versions
                else str(doc_id)
            )
            for doc_id in (self.document_ids or [])
        ]

    @field_validator("document_ids")
    @classmethod
    def validate_document_ids(cls, value: list[int] | None) -> list[int] | None:
        """Validate and deduplicate document scope IDs."""
        if value is None:
            return None
        if not value:
            raise ValueError("document_ids must not be empty")
        if any(document_id < 1 for document_id in value):
            raise ValueError("document_ids must contain positive integers")
        return list(dict.fromkeys(value))
