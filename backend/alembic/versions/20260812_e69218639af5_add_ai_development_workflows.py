"""Add project AI-development workflow records.

Revision ID: e69218639af5
Revises: f5e4d3c2b1a0
Create Date: 2026-08-12 13:15:51.581720+08:00
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from shared.models.db.types import big_integer_id_type

revision: str = "e69218639af5"
down_revision: str | Sequence[str] | None = "f5e4d3c2b1a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EPOCH = "1970-01-01 00:00:00"


def _string(
    name: str,
    length: int,
    default: str = "",
    comment: str = "",
) -> sa.Column:
    return sa.Column(
        name,
        sa.String(length=length),
        nullable=False,
        server_default=default,
        comment=comment or name,
    )


def _integer(
    name: str,
    default: str = "0",
    comment: str = "",
) -> sa.Column:
    return sa.Column(
        name,
        sa.Integer(),
        nullable=False,
        server_default=default,
        comment=comment or name,
    )


def _datetime(
    name: str,
    default: str | None = EPOCH,
    comment: str = "",
) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(),
        nullable=False,
        server_default=sa.func.now() if default is None else default,
        comment=comment or name,
    )


def _text(name: str, comment: str = "") -> sa.Column:
    return sa.Column(
        name,
        sa.Text(),
        nullable=False,
        server_default=sa.text("('')"),
        comment=comment or name,
    )


def _json(
    name: str,
    comment: str = "",
    *,
    array: bool = False,
) -> sa.Column:
    return sa.Column(
        name,
        sa.JSON(),
        nullable=False,
        server_default=sa.text("(JSON_ARRAY())" if array else "(JSON_OBJECT())"),
        comment=comment or name,
    )


def _timestamps() -> tuple[sa.Column, sa.Column]:
    return (
        _datetime("created_at", None, "Creation time"),
        _datetime("updated_at", None, "Last update time"),
    )


def upgrade() -> None:
    """Create workflow records and link queue executions to workflow stages."""
    op.add_column(
        "loop_item_executions",
        _string("workflow_run_id", 64, comment="Owning workflow run id"),
    )
    op.add_column(
        "loop_item_executions",
        _string("stage_run_id", 64, comment="Owning workflow stage run id"),
    )
    op.add_column(
        "loop_item_executions",
        _integer("attempt", "1", "Workflow stage attempt"),
    )
    op.add_column(
        "loop_item_executions",
        _string("actor_type", 16, comment="Workflow execution actor type"),
    )
    op.add_column(
        "loop_item_executions",
        _string("actor_id", 64, comment="Workflow execution actor id"),
    )
    op.add_column(
        "loop_item_executions",
        _json("actor_snapshot", "Resolved workflow execution actor snapshot"),
    )
    op.add_column(
        "loop_item_executions",
        _string(
            "execution_target_type",
            24,
            "registered_device",
            "registered_device or managed_container",
        ),
    )
    op.add_column(
        "loop_item_executions",
        _string("execution_target_id", 100, comment="Workflow execution target id"),
    )
    op.execute(
        sa.text(
            """
            UPDATE loop_item_executions
            SET actor_type = 'project_agent',
                actor_id = agent_id,
                actor_snapshot = JSON_OBJECT(
                    'type', 'project_agent',
                    'id', agent_id
                ),
                execution_target_type = CASE
                    WHEN execution_device_id <> '' THEN 'registered_device'
                    ELSE 'managed_container'
                END,
                execution_target_id = CASE
                    WHEN execution_device_id <> '' THEN execution_device_id
                    ELSE ''
                END
            WHERE agent_id <> ''
            """
        )
    )
    op.create_index(
        "idx_exec_workflow_stage",
        "loop_item_executions",
        ["workflow_run_id", "stage_run_id"],
    )

    op.create_table(
        "project_agent_squads",
        _string("id", 64, comment="Squad id"),
        _string("cloud_project_id", 64, comment="Owning cloud project id"),
        _string("name", 100, comment="Squad display name"),
        _string("leader_agent_id", 64, comment="Leader project agent id"),
        _json(
            "member_agent_ids",
            "Ordered project agent member ids",
            array=True,
        ),
        _text("routing_instructions", "Member routing instructions"),
        _integer("max_parallel_members", "1", "Maximum parallel member runs"),
        _string("status", 16, "active", "Squad status"),
        _integer("created_by_user_id", comment="Creator user id"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_project_agent_squads_project",
        "project_agent_squads",
        ["cloud_project_id", "status"],
    )

    op.create_table(
        "project_repository_bindings",
        _string("id", 64, comment="Repository binding id"),
        _string("cloud_project_id", 64, comment="Owning cloud project id"),
        _string("provider", 16, "generic", "Repository provider"),
        _string("repository_identity", 255, comment="Provider repository identity"),
        _string("repository_url", 700, comment="Repository clone url"),
        _string("default_branch", 255, "main", "Default branch"),
        _integer("local_project_id", comment="Bound local project id"),
        _string(
            "execution_target_type",
            24,
            "registered_device",
            "Default execution target type",
        ),
        _string(
            "execution_target_id",
            100,
            comment="Default registered device or container profile id",
        ),
        _string("credential_ref", 255, comment="Opaque credential reference"),
        _text("webhook_secret_ciphertext", "Encrypted webhook HMAC secret"),
        _datetime(
            "webhook_secret_last_rotated_at",
            comment="Last webhook secret rotation time",
        ),
        _json("workspace_policy_json", "Workspace policy"),
        _json("git_policy_json", "Git policy"),
        _json("provider_settings_json", "Provider settings without secrets"),
        _string("status", 16, "active", "Repository binding status"),
        _integer("created_by_user_id", comment="Creator user id"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "cloud_project_id",
            "repository_identity",
            name="uq_project_repository_identity",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_project_repositories_project",
        "project_repository_bindings",
        ["cloud_project_id", "status"],
    )

    op.create_table(
        "project_workflow_definitions",
        _string("id", 64, comment="Workflow definition id"),
        _string("cloud_project_id", 64, comment="Owning cloud project id"),
        _string("name", 100, comment="Workflow display name"),
        _text("description", "Workflow description"),
        _string("trigger_mode", 16, "manual", "Manual or automatic trigger"),
        _string("repository_binding_id", 64, comment="Default repository binding id"),
        _json("stages_json", "Ordered workflow stage groups", array=True),
        _string("failure_policy", 32, "pause", "Workflow failure policy"),
        _integer("is_default", comment="Whether this is the project default"),
        _string("status", 16, "active", "Workflow status"),
        _integer("created_by_user_id", comment="Creator user id"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_project_workflows_project",
        "project_workflow_definitions",
        ["cloud_project_id", "status"],
    )

    op.create_table(
        "project_workflow_automations",
        _string("id", 64, comment="Project workflow automation id"),
        _string("cloud_project_id", 64, comment="Owning cloud project id"),
        _string("name", 100, comment="Automation display name"),
        _text("description", "Automation description"),
        _string("trigger_type", 24, "manual", "Automation trigger type"),
        _json("trigger_config_json", "Cron, interval, one-time, or webhook config"),
        _string("workflow_definition_id", 64, comment="Workflow definition id"),
        _string("repository_binding_id", 64, comment="Repository binding override"),
        _string(
            "execution_target_type",
            24,
            "registered_device",
            "registered_device or managed_container",
        ),
        _string("execution_target_id", 100, comment="Execution target id"),
        _string("workspace_mode", 24, "git_worktree", "Workspace isolation mode"),
        _json("task_template_json", "Task fields created by the automation"),
        _json("payload_mapping_json", "Webhook payload-to-task field mapping"),
        _string("webhook_token", 128, comment="Opaque webhook route token"),
        _text("webhook_secret_ciphertext", "Encrypted webhook HMAC secret"),
        _integer("enabled", "1", "Whether the automation can run"),
        _datetime("next_run_at", comment="Next scheduled execution; epoch means unset"),
        _datetime("last_run_at", comment="Last execution; epoch means unset"),
        _integer("created_by_user_id", comment="Creator user id"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "webhook_token",
            name="uq_project_workflow_automation_webhook_token",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_project_workflow_automations_due",
        "project_workflow_automations",
        ["enabled", "next_run_at"],
    )
    op.create_index(
        "idx_project_workflow_automations_project",
        "project_workflow_automations",
        ["cloud_project_id", "enabled"],
    )

    op.create_table(
        "project_workflow_automation_runs",
        _string("id", 64, comment="Automation run id"),
        _string("automation_id", 64, comment="Owning automation id"),
        _string("trigger_type", 24, comment="Actual run trigger type"),
        _string("idempotency_key", 255, comment="Caller or schedule idempotency key"),
        _json("payload_json", "Mapped trigger payload"),
        _string("status", 24, "pending", "Automation run status"),
        _string("loop_item_id", 64, comment="Created task id"),
        _string("workflow_run_id", 64, comment="Started workflow run id"),
        _datetime("scheduled_for", comment="Scheduled time; epoch means unset"),
        _datetime("started_at", comment="Run start time; epoch means unset"),
        _datetime("completed_at", comment="Run completion time; epoch means unset"),
        _text("error_message", "Automation execution error"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "automation_id",
            "idempotency_key",
            name="uq_project_workflow_automation_run_idempotency",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_project_workflow_automation_runs_automation",
        "project_workflow_automation_runs",
        ["automation_id", "created_at"],
    )

    op.create_table(
        "task_execution_bindings",
        sa.Column(
            "id",
            big_integer_id_type(),
            primary_key=True,
            autoincrement=True,
            comment="Primary key",
        ),
        _string("loop_item_id", 64, comment="Bound loop item id"),
        _string(
            "target_type",
            16,
            comment="project_agent/project_squad/wegent_team/workflow",
        ),
        _string("target_id", 64, comment="Execution actor or workflow id"),
        _json("target_snapshot", "Stable execution actor reference snapshot"),
        _string("repository_binding_id", 64, comment="Repository binding id"),
        _string(
            "execution_target_type",
            24,
            "registered_device",
            "registered_device or managed_container",
        ),
        _string(
            "execution_target_id",
            100,
            comment="Registered device or managed container profile id",
        ),
        _string("workspace_mode", 24, "git_worktree", "Workspace isolation mode"),
        _integer("created_by_user_id", comment="Creator user id"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.UniqueConstraint(
            "loop_item_id",
            name="uq_task_execution_binding_item",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_task_execution_binding_target",
        "task_execution_bindings",
        ["target_type", "target_id"],
    )
    op.create_table(
        "task_workflow_runs",
        _string("id", 64, comment="Workflow run id"),
        _string("loop_item_id", 64, comment="Owning loop item id"),
        _string("workflow_definition_id", 64, comment="Workflow definition id"),
        _json("workflow_definition_snapshot", "Versioned workflow definition snapshot"),
        _string("repository_binding_id", 64, comment="Repository binding id"),
        _string(
            "execution_target_type",
            24,
            "registered_device",
            "registered_device or managed_container",
        ),
        _string("execution_target_id", 100, comment="Execution target id"),
        _json("execution_target_snapshot", "Resolved execution target snapshot"),
        _string("status", 24, "pending", "Workflow run status"),
        _string("current_group_key", 100, comment="Current stage group key"),
        _string("started_by_type", 16, "user", "Run initiator type"),
        _string("started_by_id", 64, comment="Run initiator id"),
        _string("idempotency_key", 128, comment="Caller idempotency key"),
        _string("trigger_message_id", 64, comment="Trigger project chat message id"),
        _string("failure_code", 100, comment="Machine-readable failure code"),
        _text("failure_message", "Workflow failure message"),
        _datetime("started_at", comment="Start time; epoch means unset"),
        _datetime("completed_at", comment="Completion time; epoch means unset"),
        _datetime("cancelled_at", comment="Cancellation time; epoch means unset"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "loop_item_id",
            "idempotency_key",
            name="uq_task_workflow_run_idempotency",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_task_workflow_runs_item",
        "task_workflow_runs",
        ["loop_item_id", "created_at"],
    )
    op.create_index(
        "idx_task_workflow_runs_status",
        "task_workflow_runs",
        ["status", "updated_at"],
    )

    op.create_table(
        "task_stage_runs",
        _string("id", 64, comment="Stage run id"),
        _string("workflow_run_id", 64, comment="Owning workflow run id"),
        _string("group_key", 100, comment="Stage group key"),
        _string("node_key", 100, comment="Workflow node key"),
        _string("node_type", 24, comment="Agent or platform node type"),
        _string("target_type", 16, comment="Execution actor type"),
        _string("target_id", 64, comment="Execution actor id"),
        _json("target_snapshot", "Resolved execution actor snapshot"),
        _string(
            "execution_target_type",
            24,
            "registered_device",
            "registered_device or managed_container",
        ),
        _string("execution_target_id", 100, comment="Execution target id"),
        _string("status", 24, "pending", "Stage run status"),
        _integer("attempt", "1", "Stage attempt"),
        sa.Column(
            "loop_item_execution_id",
            big_integer_id_type(),
            nullable=False,
            server_default="0",
            comment="Queue execution id; 0 means none",
        ),
        _string("runtime_instance_id", 255, comment="Resolved device or sandbox id"),
        _string("runtime_task_id", 255, comment="Runtime task id"),
        _string("workspace_id", 64, comment="Task workspace id"),
        _json("input_snapshot", "Stage input and artifact snapshot"),
        _json("output_json", "Validated structured stage output"),
        _string("failure_code", 100, comment="Machine-readable failure code"),
        _text("failure_message", "Stage failure message"),
        _datetime("started_at", comment="Start time; epoch means unset"),
        _datetime("completed_at", comment="Completion time; epoch means unset"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "workflow_run_id",
            "node_key",
            "attempt",
            name="uq_task_stage_run_attempt",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_task_stage_runs_workflow",
        "task_stage_runs",
        ["workflow_run_id", "status"],
    )
    op.create_index(
        "idx_task_stage_runs_execution",
        "task_stage_runs",
        ["loop_item_execution_id"],
    )

    op.create_table(
        "task_workflow_artifacts",
        _string("id", 64, comment="Artifact id"),
        _string("workflow_run_id", 64, comment="Owning workflow run id"),
        _string("stage_run_id", 64, comment="Producing stage run id"),
        _string("artifact_type", 64, comment="Artifact schema name"),
        _integer("schema_version", "1", "Artifact schema version"),
        _json("content_json", "Inline structured artifact content"),
        _string("object_key", 1400, comment="External object storage key"),
        _string("sha256", 64, comment="Artifact content checksum"),
        _datetime("created_at", None, "Creation time"),
        sa.PrimaryKeyConstraint("id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_workflow_artifacts_run",
        "task_workflow_artifacts",
        ["workflow_run_id", "artifact_type"],
    )
    op.create_index(
        "idx_workflow_artifacts_stage",
        "task_workflow_artifacts",
        ["stage_run_id"],
    )

    op.create_table(
        "task_workspaces",
        _string("id", 64, comment="Task workspace id"),
        _string("loop_item_id", 64, comment="Owning loop item id"),
        _string("repository_binding_id", 64, comment="Repository binding id"),
        _string(
            "execution_target_type",
            24,
            "registered_device",
            "registered_device or managed_container",
        ),
        _string("execution_target_id", 100, comment="Execution target id"),
        _string("source_workspace_path", 700, comment="Source repository path"),
        _string("workspace_path", 700, comment="Resolved execution workspace path"),
        _string("workspace_kind", 32, comment="Current workspace or git worktree"),
        _string("branch_name", 255, comment="Task branch name"),
        _string("base_branch", 255, comment="Task base branch"),
        _string("head_commit", 64, comment="Current workspace head commit"),
        _string("status", 24, "preparing", "Workspace lifecycle status"),
        _string("lease_owner", 100, comment="Workspace lease owner"),
        _datetime("lease_expires_at", comment="Lease expiry; epoch means unset"),
        _string("cleanup_policy", 32, "on_merge", "Workspace cleanup policy"),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "loop_item_id",
            "repository_binding_id",
            name="uq_task_workspace_repository",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_task_workspaces_execution_target",
        "task_workspaces",
        ["execution_target_type", "execution_target_id", "status"],
    )

    op.create_table(
        "task_development_links",
        _string("id", 64, comment="Development link id"),
        _string("loop_item_id", 64, comment="Owning loop item id"),
        _string("repository_binding_id", 64, comment="Repository binding id"),
        _string("workspace_id", 64, comment="Task workspace id"),
        _string("branch_name", 255, comment="Task branch name"),
        _string("base_branch", 255, comment="Pull request base branch"),
        _string("head_commit", 64, comment="Latest pushed commit"),
        _string("provider", 16, "generic", "Repository provider"),
        _string("pull_request_id", 100, comment="Provider pull request id"),
        _integer("pull_request_number", comment="Provider pull request number"),
        _string("pull_request_url", 1400, comment="Pull request url"),
        _string("pull_request_state", 24, comment="Pull request state"),
        _integer("draft", comment="Whether pull request is a draft"),
        _string("mergeable_state", 32, comment="Provider mergeability state"),
        _string("review_decision", 32, comment="Aggregated review decision"),
        _string("ci_state", 24, comment="Aggregated CI state"),
        _string("merged_commit", 64, comment="Merged commit sha"),
        _datetime(
            "last_provider_event_at",
            comment="Last provider event time; epoch means unset",
        ),
        _integer("version", "1", "Optimistic lock version"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "loop_item_id",
            "repository_binding_id",
            name="uq_task_development_repository",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_task_development_pull_request",
        "task_development_links",
        ["provider", "pull_request_id"],
    )

    op.create_table(
        "task_development_checks",
        _string("id", 64, comment="Development check id"),
        _string("development_link_id", 64, comment="Development link id"),
        _string("provider_check_id", 255, comment="Provider check id"),
        _string("name", 255, comment="Check display name"),
        _string("status", 24, comment="Provider check status"),
        _string("conclusion", 32, comment="Provider check conclusion"),
        _string("details_url", 1400, comment="Provider check details url"),
        _datetime("started_at", comment="Check start time; epoch means unset"),
        _datetime("completed_at", comment="Check completion time; epoch means unset"),
        _datetime("updated_at", None, "Last update time"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "development_link_id",
            "provider_check_id",
            name="uq_task_development_provider_check",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_task_development_checks_link",
        "task_development_checks",
        ["development_link_id", "status"],
    )

    op.create_table(
        "task_development_review_threads",
        _string("id", 64, comment="Review thread id"),
        _string("development_link_id", 64, comment="Development link id"),
        _string("provider_thread_id", 255, comment="Provider review thread id"),
        _string("provider_comment_id", 255, comment="Latest provider comment id"),
        _string("path", 700, comment="Reviewed repository path"),
        _integer("line", comment="Reviewed line; 0 means unavailable"),
        _string("side", 16, comment="Diff side"),
        _string("author", 255, comment="Latest comment author"),
        _text("body", "Latest review comment body"),
        _string("url", 1400, comment="Provider review thread url"),
        _string("status", 24, "open", "open, resolved, or outdated"),
        _string("review_state", 32, comment="Review decision associated with thread"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "development_link_id",
            "provider_thread_id",
            name="uq_task_development_review_thread",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_task_development_review_threads_link",
        "task_development_review_threads",
        ["development_link_id", "status"],
    )

    op.create_table(
        "repository_provider_events",
        sa.Column(
            "id",
            big_integer_id_type(),
            primary_key=True,
            autoincrement=True,
            comment="Primary key",
        ),
        _string("repository_binding_id", 64, comment="Repository binding id"),
        _string("provider_event_id", 255, comment="Provider event id"),
        _string("event_type", 100, comment="Provider event type"),
        _string("delivery_id", 255, comment="Webhook delivery id"),
        _string("payload_sha256", 64, comment="Webhook payload checksum"),
        _datetime("received_at", None, "Webhook receipt time"),
        _datetime("processed_at", comment="Processing time; epoch means unset"),
        _string("processing_status", 24, "pending", "Event processing status"),
        _text("error_message", "Event processing error"),
        sa.UniqueConstraint(
            "repository_binding_id",
            "delivery_id",
            name="uq_repository_provider_delivery",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_repository_provider_events_status",
        "repository_provider_events",
        ["processing_status", "received_at"],
    )


def downgrade() -> None:
    """Remove workflow records and queue links."""
    op.drop_table("repository_provider_events")
    op.drop_table("task_development_review_threads")
    op.drop_table("task_development_checks")
    op.drop_table("task_development_links")
    op.drop_table("task_workspaces")
    op.drop_table("task_workflow_artifacts")
    op.drop_table("task_stage_runs")
    op.drop_table("task_workflow_runs")
    op.drop_table("task_execution_bindings")
    op.drop_table("project_workflow_automation_runs")
    op.drop_table("project_workflow_automations")
    op.drop_table("project_workflow_definitions")
    op.drop_table("project_repository_bindings")
    op.drop_table("project_agent_squads")
    op.drop_index("idx_exec_workflow_stage", table_name="loop_item_executions")
    op.drop_column("loop_item_executions", "execution_target_id")
    op.drop_column("loop_item_executions", "execution_target_type")
    op.drop_column("loop_item_executions", "actor_snapshot")
    op.drop_column("loop_item_executions", "actor_id")
    op.drop_column("loop_item_executions", "actor_type")
    op.drop_column("loop_item_executions", "attempt")
    op.drop_column("loop_item_executions", "stage_run_id")
    op.drop_column("loop_item_executions", "workflow_run_id")
