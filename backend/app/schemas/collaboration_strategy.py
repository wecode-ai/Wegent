# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Versioned, readable collaboration policy and coordinator boundary contracts."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

COORDINATOR_EVIDENCE_LIMIT = 100

StrategyStage = Literal[
    "requirement_intake",
    "joint_review",
    "development_preparation",
    "development_implementation",
    "quality_acceptance",
    "release_launch",
]
StageReviewRole = Literal["product", "development", "design", "qa"]
StageReviewOutcome = Literal["no_objection", "objection", "conditional"]


class CollaborationStrategyPublish(BaseModel):
    text: str = Field(min_length=1, max_length=100000)
    expected_version: int = Field(ge=0)

    @model_validator(mode="after")
    def normalize_text(self) -> "CollaborationStrategyPublish":
        self.text = self.text.strip()
        if not self.text:
            raise ValueError("strategy text cannot be empty")
        return self


class CollaborationStrategyRevision(BaseModel):
    version: int = Field(ge=1)
    text: str
    diff: str
    published_at: datetime
    published_by: int
    role_mapping: dict[str, list[str]] = Field(default_factory=dict)
    source_path: str = "docs/35-agentic-collaboration-strategy.md"


class IntakeDefinition(BaseModel):
    objective: str = Field(default="", max_length=10000)
    scope: str = Field(default="", max_length=10000)
    non_goals: str = Field(default="", max_length=10000)
    acceptance_criteria: str = Field(default="", max_length=10000)
    dependencies: str = Field(default="", max_length=10000)
    proposed_owner: str = Field(default="", max_length=100)


class StageReviewInput(BaseModel):
    decision: StageReviewOutcome
    function_role: StageReviewRole | None = None
    comment: str = Field(default="", max_length=4000)
    evidence_refs: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def require_feedback(self) -> "StageReviewInput":
        self.comment = self.comment.strip()
        if self.decision != "no_objection" and not self.comment:
            raise ValueError("Objections and conditional reviews require a comment")
        return self


class StageReviewDecision(StageReviewInput):
    stage_id: StrategyStage
    function_role: StageReviewRole
    reviewer_id: int = Field(ge=1)
    attempt: int = Field(default=1, ge=1)
    issue_version: int = Field(ge=1)
    strategy_version: int = Field(ge=1)
    created_at: datetime
    idempotency_key: str = Field(min_length=1, max_length=128)


class ReleaseRecordInput(BaseModel):
    version: str = Field(min_length=1, max_length=255)
    url: str = Field(min_length=1, max_length=2000)
    released_at: datetime
    environment: str = Field(min_length=1, max_length=100)
    merge_commits: list[str] = Field(default_factory=list, max_length=100)
    online_verification: str = Field(default="", max_length=4000)
    rollback_summary: str = Field(default="", max_length=4000)
    retrospective: str = Field(default="", max_length=4000)
    successful: bool = True

    @model_validator(mode="after")
    def require_success_evidence(self) -> "ReleaseRecordInput":
        self.merge_commits = [
            value.strip().lower() for value in self.merge_commits if value.strip()
        ]
        if self.successful and not self.merge_commits:
            raise ValueError("Successful releases require merge commit mappings")
        return self


class CoordinatorDecision(BaseModel):
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence_conflict: bool = False
    strategy_version: int = Field(ge=1)
    issue_version: int = Field(ge=1)
    stage: StrategyStage | Literal["inbox"]
    next_owner: str | None
    next_action: str = Field(min_length=1, max_length=2000)
    satisfied_conditions: list[str] = Field(max_length=100)
    missing_conditions: list[str] = Field(max_length=100)
    evidence_refs: list[str] = Field(max_length=COORDINATOR_EVIDENCE_LIMIT)
    clarification: str | None = Field(max_length=2000)
    idempotency_key: str = Field(min_length=1, max_length=128)
    integration_status: Literal["recorded"] = "recorded"

    @model_validator(mode="after")
    def require_evidence(self) -> "CoordinatorDecision":
        if not self.evidence_refs:
            raise ValueError("coordinator decisions require evidence references")
        if not self.next_action.strip():
            raise ValueError("coordinator next action cannot be blank")
        if (
            self.evidence_conflict
            or (self.confidence is not None and self.confidence < 0.8)
        ) and not (self.clarification or "").strip():
            raise ValueError(
                "Low confidence or conflicting evidence requires human clarification"
            )
        return self
