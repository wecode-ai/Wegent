# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Completion Condition schemas for API requests and responses
"""
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class ConditionType(str, Enum):
    """Type of completion condition"""

    CI_PIPELINE = "CI_PIPELINE"
    EXTERNAL_TASK = "EXTERNAL_TASK"
    APPROVAL = "APPROVAL"
    MANUAL_CONFIRM = "MANUAL_CONFIRM"


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
    """Base schema for completion condition"""

    subtask_id: int
    task_id: int
    condition_type: ConditionType = ConditionType.CI_PIPELINE
    status: ConditionStatus = ConditionStatus.PENDING
    external_id: Optional[str] = None
    external_url: Optional[str] = None
    git_platform: Optional[GitPlatform] = None
    git_domain: Optional[str] = None
    repo_full_name: Optional[str] = None
    branch_name: Optional[str] = None
    max_retries: int = 5
    metadata: Optional[Dict[str, Any]] = None


class CompletionConditionCreate(CompletionConditionBase):
    """Schema for creating a completion condition"""

    pass


class CompletionConditionUpdate(BaseModel):
    """Schema for updating a completion condition"""

    status: Optional[ConditionStatus] = None
    external_id: Optional[str] = None
    external_url: Optional[str] = None
    retry_count: Optional[int] = None
    last_failure_log: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    satisfied_at: Optional[datetime] = None


class CompletionConditionInDB(CompletionConditionBase):
    """Schema for completion condition from database"""

    id: int
    user_id: int
    retry_count: int = 0
    last_failure_log: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    satisfied_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class CompletionConditionListResponse(BaseModel):
    """Paginated response for completion conditions"""

    total: int
    items: List[CompletionConditionInDB]


class TaskCompletionStatus(BaseModel):
    """Overall completion status for a task"""

    task_id: int
    subtask_completed: bool
    all_conditions_satisfied: bool
    pending_conditions: int
    in_progress_conditions: int
    satisfied_conditions: int
    failed_conditions: int
    conditions: List[CompletionConditionInDB]


# Webhook event schemas
class CIEventType(str, Enum):
    """CI event types"""

    PIPELINE_STARTED = "pipeline_started"
    PIPELINE_SUCCESS = "pipeline_success"
    PIPELINE_FAILED = "pipeline_failed"
    CHECK_RUN_STARTED = "check_run_started"
    CHECK_RUN_COMPLETED = "check_run_completed"


class CIWebhookEvent(BaseModel):
    """Schema for CI webhook events"""

    event_type: CIEventType
    repo_full_name: str
    branch_name: str
    external_id: str
    external_url: Optional[str] = None
    conclusion: Optional[str] = None  # success, failure, etc.
    logs_url: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class GitHubCheckRunEvent(BaseModel):
    """Schema for GitHub check_run webhook event"""

    action: str  # created, completed, rerequested
    check_run: Dict[str, Any]
    repository: Dict[str, Any]


class GitHubWorkflowRunEvent(BaseModel):
    """Schema for GitHub workflow_run webhook event"""

    action: str  # requested, completed
    workflow_run: Dict[str, Any]
    repository: Dict[str, Any]


class GitLabPipelineEvent(BaseModel):
    """Schema for GitLab pipeline webhook event"""

    object_kind: str  # pipeline
    object_attributes: Dict[str, Any]
    project: Dict[str, Any]
