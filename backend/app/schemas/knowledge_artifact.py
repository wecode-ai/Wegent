# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for knowledge-base generated artifacts."""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class KnowledgeArtifactType(str, Enum):
    """Artifact types supported by the MVP."""

    BRIEFING = "briefing"
    MIND_MAP = "mind_map"


class KnowledgeArtifactStatus(str, Enum):
    """Artifact generation lifecycle."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class KnowledgeArtifactExecutionHealth(str, Enum):
    """Derived health of a non-terminal Artifact execution."""

    HEALTHY = "healthy"
    STALLED = "stalled"


class KnowledgeArtifactCreate(BaseModel):
    """Create-artifact request."""

    artifact_type: KnowledgeArtifactType
    title: str | None = Field(default=None, max_length=255)
    document_ids: list[int] = Field(default_factory=list)
    instruction: str | None = Field(default=None, max_length=10_000)

    @field_validator("document_ids")
    @classmethod
    def validate_document_ids(cls, value: list[int]) -> list[int]:
        """Require positive, unique IDs while preserving request order."""
        if any(document_id <= 0 for document_id in value):
            raise ValueError("document_ids must contain positive integers")
        return list(dict.fromkeys(value))


class KnowledgeArtifactUpdate(BaseModel):
    """Fields editable in the MVP."""

    title: str = Field(min_length=1, max_length=255)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        """Reject whitespace-only titles."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("title cannot be empty")
        return normalized


class KnowledgeArtifact(BaseModel):
    """Persisted Artifact record and API response."""

    schema_version: int = 1
    version: int = 1
    attempt: int = 1
    artifact_id: str
    knowledge_base_id: int
    artifact_type: KnowledgeArtifactType
    title: str
    status: KnowledgeArtifactStatus
    task_id: int | None = None
    assistant_subtask_id: int | None = None
    content: str | None = None
    source_document_ids: list[int] = Field(default_factory=list)
    generation_config: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None
    error_message: str | None = None
    execution_health: KnowledgeArtifactExecutionHealth = (
        KnowledgeArtifactExecutionHealth.HEALTHY
    )
    can_retry: bool = False
    user_id: int
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class KnowledgeArtifactListResponse(BaseModel):
    """Artifact list plus management capability."""

    items: list[KnowledgeArtifact]
    can_manage: bool
    available_document_count: int
    processing_document_count: int
