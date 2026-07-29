# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for knowledge-base generated artifacts."""

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

MAX_MIND_MAP_NODES = 200
MAX_MIND_MAP_DEPTH = 6


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


class MindMapNode(BaseModel):
    """One stable semantic node in an interactive mind map."""

    id: str = Field(min_length=1, max_length=100)
    parent_id: str | None = Field(default=None, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=1000)

    @field_validator("id", "title")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        """Strip required node fields and reject whitespace-only values."""
        normalized = value.strip()
        if not normalized:
            raise ValueError("value cannot be empty")
        return normalized

    @field_validator("parent_id", "summary")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        """Normalize optional node text."""
        if value is None:
            return None
        return value.strip() or None


class MindMapContent(BaseModel):
    """Versioned tree data used by the interactive mind map viewer."""

    schema_version: Literal[1] = 1
    root_id: str = Field(min_length=1, max_length=100)
    nodes: list[MindMapNode] = Field(
        min_length=1,
        max_length=MAX_MIND_MAP_NODES,
    )

    @model_validator(mode="after")
    def validate_tree(self) -> "MindMapContent":
        """Require one connected, acyclic tree within the supported depth."""
        nodes_by_id = {node.id: node for node in self.nodes}
        if len(nodes_by_id) != len(self.nodes):
            raise ValueError("mind map node IDs must be unique")
        if self.root_id not in nodes_by_id:
            raise ValueError("mind map root_id must reference an existing node")

        roots = [node for node in self.nodes if node.parent_id is None]
        if len(roots) != 1 or roots[0].id != self.root_id:
            raise ValueError("mind map must contain exactly one declared root")

        for node in self.nodes:
            if node.parent_id is not None and node.parent_id not in nodes_by_id:
                raise ValueError(f"mind map parent does not exist: {node.parent_id}")

        for node in self.nodes:
            depth = 0
            current = node
            visited: set[str] = set()
            while current.parent_id is not None:
                if current.id in visited:
                    raise ValueError("mind map must not contain cycles")
                visited.add(current.id)
                depth += 1
                if depth > MAX_MIND_MAP_DEPTH:
                    raise ValueError(
                        f"mind map depth must not exceed {MAX_MIND_MAP_DEPTH}"
                    )
                current = nodes_by_id[current.parent_id]
            if current.id != self.root_id:
                raise ValueError("all mind map nodes must connect to the root")
        return self


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
    knowledge_base_id: int = Field(gt=0)
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
    can_delete: bool = False
    user_id: int = Field(gt=0)
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class KnowledgeArtifactListResponse(BaseModel):
    """Artifact list plus management capability."""

    items: list[KnowledgeArtifact]
    can_manage: bool
    available_document_count: int
    processing_document_count: int
