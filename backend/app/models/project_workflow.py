# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistent project AI-development workflow records."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)
EPOCH_SERVER_DEFAULT = "1970-01-01 00:00:00"


class ProjectAgentSquad(Base):
    __tablename__ = "project_agent_squads"

    id = Column(String(64), primary_key=True)
    cloud_project_id = Column(String(64), nullable=False, default="", server_default="")
    name = Column(String(100), nullable=False, default="", server_default="")
    leader_agent_id = Column(String(64), nullable=False, default="", server_default="")
    member_agent_ids = Column(JSON, nullable=False, default=list)
    routing_instructions = Column(Text, nullable=False, default="")
    max_parallel_members = Column(
        Integer, nullable=False, default=1, server_default="1"
    )
    status = Column(
        String(16), nullable=False, default="active", server_default="active"
    )
    created_by_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("idx_project_agent_squads_project", "cloud_project_id", "status"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class ProjectRepositoryBinding(Base):
    __tablename__ = "project_repository_bindings"

    id = Column(String(64), primary_key=True)
    cloud_project_id = Column(String(64), nullable=False, default="", server_default="")
    provider = Column(
        String(16), nullable=False, default="generic", server_default="generic"
    )
    repository_identity = Column(
        String(255), nullable=False, default="", server_default=""
    )
    repository_url = Column(String(700), nullable=False, default="", server_default="")
    default_branch = Column(
        String(255), nullable=False, default="main", server_default="main"
    )
    local_project_id = Column(Integer, nullable=False, default=0, server_default="0")
    execution_target_type = Column(
        String(24),
        nullable=False,
        default="registered_device",
        server_default="registered_device",
    )
    execution_target_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    credential_ref = Column(String(255), nullable=False, default="", server_default="")
    webhook_secret_ciphertext = Column(Text, nullable=False, default="")
    webhook_secret_last_rotated_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    workspace_policy_json = Column(JSON, nullable=False, default=dict)
    git_policy_json = Column(JSON, nullable=False, default=dict)
    provider_settings_json = Column(JSON, nullable=False, default=dict)
    status = Column(
        String(16), nullable=False, default="active", server_default="active"
    )
    created_by_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "cloud_project_id",
            "repository_identity",
            name="uq_project_repository_identity",
        ),
        Index("idx_project_repositories_project", "cloud_project_id", "status"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class ProjectWorkflowDefinition(Base):
    __tablename__ = "project_workflow_definitions"

    id = Column(String(64), primary_key=True)
    cloud_project_id = Column(String(64), nullable=False, default="", server_default="")
    name = Column(String(100), nullable=False, default="", server_default="")
    description = Column(Text, nullable=False, default="")
    trigger_mode = Column(
        String(16), nullable=False, default="manual", server_default="manual"
    )
    repository_binding_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    stages_json = Column(JSON, nullable=False, default=list)
    failure_policy = Column(
        String(32), nullable=False, default="pause", server_default="pause"
    )
    is_default = Column(Integer, nullable=False, default=0, server_default="0")
    status = Column(
        String(16), nullable=False, default="active", server_default="active"
    )
    created_by_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("idx_project_workflows_project", "cloud_project_id", "status"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class ProjectWorkflowAutomation(Base):
    __tablename__ = "project_workflow_automations"

    id = Column(String(64), primary_key=True)
    cloud_project_id = Column(String(64), nullable=False, default="", server_default="")
    name = Column(String(100), nullable=False, default="", server_default="")
    description = Column(Text, nullable=False, default="")
    trigger_type = Column(
        String(24), nullable=False, default="manual", server_default="manual"
    )
    trigger_config_json = Column(JSON, nullable=False, default=dict)
    workflow_definition_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    repository_binding_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    execution_target_type = Column(
        String(24),
        nullable=False,
        default="registered_device",
        server_default="registered_device",
    )
    execution_target_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    workspace_mode = Column(
        String(24),
        nullable=False,
        default="git_worktree",
        server_default="git_worktree",
    )
    task_template_json = Column(JSON, nullable=False, default=dict)
    payload_mapping_json = Column(JSON, nullable=False, default=dict)
    webhook_token = Column(String(128), nullable=False, default="", server_default="")
    webhook_secret_ciphertext = Column(Text, nullable=False, default="")
    enabled = Column(Integer, nullable=False, default=1, server_default="1")
    next_run_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    last_run_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    created_by_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index(
            "idx_project_workflow_automations_due",
            "enabled",
            "next_run_at",
        ),
        Index(
            "idx_project_workflow_automations_project",
            "cloud_project_id",
            "enabled",
        ),
        UniqueConstraint(
            "webhook_token",
            name="uq_project_workflow_automation_webhook_token",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class ProjectWorkflowAutomationRun(Base):
    __tablename__ = "project_workflow_automation_runs"

    id = Column(String(64), primary_key=True)
    automation_id = Column(String(64), nullable=False, default="", server_default="")
    trigger_type = Column(String(24), nullable=False, default="", server_default="")
    idempotency_key = Column(String(255), nullable=False, default="", server_default="")
    payload_json = Column(JSON, nullable=False, default=dict)
    status = Column(
        String(24), nullable=False, default="pending", server_default="pending"
    )
    loop_item_id = Column(String(64), nullable=False, default="", server_default="")
    workflow_run_id = Column(String(64), nullable=False, default="", server_default="")
    scheduled_for = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    started_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    completed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    error_message = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "automation_id",
            "idempotency_key",
            name="uq_project_workflow_automation_run_idempotency",
        ),
        Index(
            "idx_project_workflow_automation_runs_automation",
            "automation_id",
            "created_at",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskExecutionBinding(Base):
    __tablename__ = "task_execution_bindings"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    loop_item_id = Column(String(64), nullable=False, default="", server_default="")
    target_type = Column(String(16), nullable=False, default="", server_default="")
    target_id = Column(String(64), nullable=False, default="", server_default="")
    target_snapshot = Column(JSON, nullable=False, default=dict)
    repository_binding_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    execution_target_type = Column(
        String(24),
        nullable=False,
        default="registered_device",
        server_default="registered_device",
    )
    execution_target_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    workspace_mode = Column(
        String(24),
        nullable=False,
        default="git_worktree",
        server_default="git_worktree",
    )
    created_by_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("loop_item_id", name="uq_task_execution_binding_item"),
        Index("idx_task_execution_binding_target", "target_type", "target_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskWorkflowRun(Base):
    __tablename__ = "task_workflow_runs"

    id = Column(String(64), primary_key=True)
    loop_item_id = Column(String(64), nullable=False, default="", server_default="")
    workflow_definition_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    workflow_definition_snapshot = Column(JSON, nullable=False, default=dict)
    repository_binding_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    execution_target_type = Column(
        String(24),
        nullable=False,
        default="registered_device",
        server_default="registered_device",
    )
    execution_target_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    execution_target_snapshot = Column(JSON, nullable=False, default=dict)
    status = Column(
        String(24), nullable=False, default="pending", server_default="pending"
    )
    current_group_key = Column(
        String(100), nullable=False, default="", server_default=""
    )
    started_by_type = Column(
        String(16), nullable=False, default="user", server_default="user"
    )
    started_by_id = Column(String(64), nullable=False, default="", server_default="")
    idempotency_key = Column(String(128), nullable=False, default="", server_default="")
    trigger_message_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    failure_code = Column(String(100), nullable=False, default="", server_default="")
    failure_message = Column(Text, nullable=False, default="")
    started_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    completed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    cancelled_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "loop_item_id",
            "idempotency_key",
            name="uq_task_workflow_run_idempotency",
        ),
        Index("idx_task_workflow_runs_item", "loop_item_id", "created_at"),
        Index("idx_task_workflow_runs_status", "status", "updated_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskStageRun(Base):
    __tablename__ = "task_stage_runs"

    id = Column(String(64), primary_key=True)
    workflow_run_id = Column(String(64), nullable=False, default="", server_default="")
    group_key = Column(String(100), nullable=False, default="", server_default="")
    node_key = Column(String(100), nullable=False, default="", server_default="")
    node_type = Column(String(24), nullable=False, default="", server_default="")
    target_type = Column(String(16), nullable=False, default="", server_default="")
    target_id = Column(String(64), nullable=False, default="", server_default="")
    target_snapshot = Column(JSON, nullable=False, default=dict)
    execution_target_type = Column(
        String(24),
        nullable=False,
        default="registered_device",
        server_default="registered_device",
    )
    execution_target_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    status = Column(
        String(24), nullable=False, default="pending", server_default="pending"
    )
    attempt = Column(Integer, nullable=False, default=1, server_default="1")
    loop_item_execution_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    runtime_instance_id = Column(
        String(255), nullable=False, default="", server_default=""
    )
    runtime_task_id = Column(String(255), nullable=False, default="", server_default="")
    workspace_id = Column(String(64), nullable=False, default="", server_default="")
    input_snapshot = Column(JSON, nullable=False, default=dict)
    output_json = Column(JSON, nullable=False, default=dict)
    failure_code = Column(String(100), nullable=False, default="", server_default="")
    failure_message = Column(Text, nullable=False, default="")
    started_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    completed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "workflow_run_id",
            "node_key",
            "attempt",
            name="uq_task_stage_run_attempt",
        ),
        Index("idx_task_stage_runs_workflow", "workflow_run_id", "status"),
        Index("idx_task_stage_runs_execution", "loop_item_execution_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskWorkflowArtifact(Base):
    __tablename__ = "task_workflow_artifacts"

    id = Column(String(64), primary_key=True)
    workflow_run_id = Column(String(64), nullable=False, default="", server_default="")
    stage_run_id = Column(String(64), nullable=False, default="", server_default="")
    artifact_type = Column(String(64), nullable=False, default="", server_default="")
    schema_version = Column(Integer, nullable=False, default=1, server_default="1")
    content_json = Column(JSON, nullable=False, default=dict)
    object_key = Column(String(1400), nullable=False, default="", server_default="")
    sha256 = Column(String(64), nullable=False, default="", server_default="")
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_workflow_artifacts_run", "workflow_run_id", "artifact_type"),
        Index("idx_workflow_artifacts_stage", "stage_run_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskWorkspace(Base):
    __tablename__ = "task_workspaces"

    id = Column(String(64), primary_key=True)
    loop_item_id = Column(String(64), nullable=False, default="", server_default="")
    repository_binding_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    execution_target_type = Column(
        String(24),
        nullable=False,
        default="registered_device",
        server_default="registered_device",
    )
    execution_target_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    source_workspace_path = Column(
        String(700), nullable=False, default="", server_default=""
    )
    workspace_path = Column(String(700), nullable=False, default="", server_default="")
    workspace_kind = Column(String(32), nullable=False, default="", server_default="")
    branch_name = Column(String(255), nullable=False, default="", server_default="")
    base_branch = Column(String(255), nullable=False, default="", server_default="")
    head_commit = Column(String(64), nullable=False, default="", server_default="")
    status = Column(
        String(24), nullable=False, default="preparing", server_default="preparing"
    )
    lease_owner = Column(String(100), nullable=False, default="", server_default="")
    lease_expires_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    cleanup_policy = Column(
        String(32), nullable=False, default="on_merge", server_default="on_merge"
    )
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "loop_item_id", "repository_binding_id", name="uq_task_workspace_repository"
        ),
        Index(
            "idx_task_workspaces_execution_target",
            "execution_target_type",
            "execution_target_id",
            "status",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskDevelopmentLink(Base):
    __tablename__ = "task_development_links"

    id = Column(String(64), primary_key=True)
    loop_item_id = Column(String(64), nullable=False, default="", server_default="")
    repository_binding_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    workspace_id = Column(String(64), nullable=False, default="", server_default="")
    branch_name = Column(String(255), nullable=False, default="", server_default="")
    base_branch = Column(String(255), nullable=False, default="", server_default="")
    head_commit = Column(String(64), nullable=False, default="", server_default="")
    provider = Column(
        String(16), nullable=False, default="generic", server_default="generic"
    )
    pull_request_id = Column(String(100), nullable=False, default="", server_default="")
    pull_request_number = Column(Integer, nullable=False, default=0, server_default="0")
    pull_request_url = Column(
        String(1400), nullable=False, default="", server_default=""
    )
    pull_request_state = Column(
        String(24), nullable=False, default="", server_default=""
    )
    draft = Column(Integer, nullable=False, default=0, server_default="0")
    mergeable_state = Column(String(32), nullable=False, default="", server_default="")
    review_decision = Column(String(32), nullable=False, default="", server_default="")
    ci_state = Column(String(24), nullable=False, default="", server_default="")
    merged_commit = Column(String(64), nullable=False, default="", server_default="")
    last_provider_event_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "loop_item_id",
            "repository_binding_id",
            name="uq_task_development_repository",
        ),
        Index(
            "idx_task_development_pull_request",
            "provider",
            "pull_request_id",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskDevelopmentCheck(Base):
    __tablename__ = "task_development_checks"

    id = Column(String(64), primary_key=True)
    development_link_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    provider_check_id = Column(
        String(255), nullable=False, default="", server_default=""
    )
    name = Column(String(255), nullable=False, default="", server_default="")
    status = Column(String(24), nullable=False, default="", server_default="")
    conclusion = Column(String(32), nullable=False, default="", server_default="")
    details_url = Column(String(1400), nullable=False, default="", server_default="")
    started_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    completed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "development_link_id",
            "provider_check_id",
            name="uq_task_development_provider_check",
        ),
        Index("idx_task_development_checks_link", "development_link_id", "status"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class TaskDevelopmentReviewThread(Base):
    __tablename__ = "task_development_review_threads"

    id = Column(String(64), primary_key=True)
    development_link_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    provider_thread_id = Column(
        String(255), nullable=False, default="", server_default=""
    )
    provider_comment_id = Column(
        String(255), nullable=False, default="", server_default=""
    )
    path = Column(String(700), nullable=False, default="", server_default="")
    line = Column(Integer, nullable=False, default=0, server_default="0")
    side = Column(String(16), nullable=False, default="", server_default="")
    author = Column(String(255), nullable=False, default="", server_default="")
    body = Column(Text, nullable=False, default="")
    url = Column(String(1400), nullable=False, default="", server_default="")
    status = Column(String(24), nullable=False, default="open", server_default="open")
    review_state = Column(String(32), nullable=False, default="", server_default="")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "development_link_id",
            "provider_thread_id",
            name="uq_task_development_review_thread",
        ),
        Index(
            "idx_task_development_review_threads_link",
            "development_link_id",
            "status",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class RepositoryProviderEvent(Base):
    __tablename__ = "repository_provider_events"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    repository_binding_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    provider_event_id = Column(
        String(255), nullable=False, default="", server_default=""
    )
    event_type = Column(String(100), nullable=False, default="", server_default="")
    delivery_id = Column(String(255), nullable=False, default="", server_default="")
    payload_sha256 = Column(String(64), nullable=False, default="", server_default="")
    received_at = Column(DateTime, nullable=False, server_default=func.now())
    processed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default=EPOCH_SERVER_DEFAULT,
    )
    processing_status = Column(
        String(24), nullable=False, default="pending", server_default="pending"
    )
    error_message = Column(Text, nullable=False, default="")

    __table_args__ = (
        UniqueConstraint(
            "repository_binding_id",
            "delivery_id",
            name="uq_repository_provider_delivery",
        ),
        Index(
            "idx_repository_provider_events_status", "processing_status", "received_at"
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )
