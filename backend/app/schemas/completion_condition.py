# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
CompletionCondition schemas for API request/response models
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional

from pydantic import BaseModel


class ConditionType(str, Enum):
    """Type of completion condition"""
    CI_PIPELINE = "CI_PIPELINE"


class ConditionStatus(str, Enum):
    """Status of completion condition"""
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    SATISFIED = "SATISFIED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class GitPlatform(str, Enum):
    """Git platform type"""
    GITHUB = "GITHUB"
    GITLAB = "GITLAB"


class CompletionConditionBase(BaseModel):
    """Base schema for CompletionCondition"""
    subtask_id: int
    task_id: int
    condition_type: ConditionType = ConditionType.CI_PIPELINE
    trigger_type: Optional[str] = None
    external_id: Optional[str] = None
    external_url: Optional[str] = None
    git_platform: Optional[GitPlatform] = None
    git_domain: Optional[str] = None
    repo_full_name: Optional[str] = None
    branch_name: Optional[str] = None
    max_retries: int = 5
    session_id: Optional[str] = None
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class CompletionConditionCreate(CompletionConditionBase):
    """Schema for creating a CompletionCondition"""
    user_id: int


class CompletionConditionUpdate(BaseModel):
    """Schema for updating a CompletionCondition"""
    status: Optional[ConditionStatus] = None
    external_id: Optional[str] = None
    external_url: Optional[str] = None
    retry_count: Optional[int] = None
    last_failure_log: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    satisfied_at: Optional[datetime] = None


class CompletionConditionInDB(CompletionConditionBase):
    """Schema for CompletionCondition from database"""
    id: int
    user_id: int
    status: ConditionStatus
    retry_count: int
    last_failure_log: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    satisfied_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class CompletionConditionResponse(CompletionConditionInDB):
    """Schema for API response"""
    pass


class CompletionConditionListResponse(BaseModel):
    """Paginated list response"""
    total: int
    items: list[CompletionConditionResponse]


class SubtaskCompletionStatus(BaseModel):
    """Combined status of a subtask with all its completion conditions"""
    subtask_id: int
    subtask_status: str
    conditions: list[CompletionConditionResponse]
    all_satisfied: bool
    has_failed: bool
    pending_count: int
    in_progress_count: int


# CI Event Schemas
class CIEventBase(BaseModel):
    """Base schema for CI events"""
    repo_full_name: str
    branch_name: str
    git_platform: GitPlatform


class GitHubCheckRunEvent(CIEventBase):
    """Schema for GitHub check_run webhook event"""
    check_run_id: int
    check_suite_id: int
    conclusion: Optional[str] = None  # success, failure, neutral, cancelled, etc.
    status: str  # queued, in_progress, completed
    name: str  # Check run name
    html_url: Optional[str] = None
    output: Optional[Dict[str, Any]] = None


class GitHubWorkflowRunEvent(CIEventBase):
    """Schema for GitHub workflow_run webhook event"""
    workflow_run_id: int
    workflow_id: int
    conclusion: Optional[str] = None
    status: str  # queued, in_progress, completed
    name: str
    html_url: Optional[str] = None
    run_attempt: int = 1


class GitLabPipelineEvent(CIEventBase):
    """Schema for GitLab Pipeline webhook event"""
    pipeline_id: int
    project_id: int
    status: str  # pending, running, success, failed, canceled, skipped
    ref: str  # Branch name
    web_url: Optional[str] = None
    source: Optional[str] = None  # push, web, trigger, etc.


class CIFailureInfo(BaseModel):
    """Information about a CI failure"""
    check_types: list[str]  # test, lint, build, etc.
    failure_log: str
    failure_url: Optional[str] = None
    job_name: Optional[str] = None
