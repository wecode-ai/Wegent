# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add Runtime-observation truth to existing loop item executions.

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-08-15

This migration intentionally creates no table. One loop_item_executions row is
one attempt; the added columns separate queue/control state from the latest
verified Runtime observation.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from shared.models.db.types import big_integer_id_type

revision: str = "d9e0f1a2b3c4"
down_revision: Union[str, Sequence[str], None] = "c8d9e0f1a2b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


UNSET_DATETIME = "1970-01-01 00:00:00"


def _add_truth_columns() -> None:
    columns = (
        sa.Column(
            "attempt_no",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="Attempt number within the execution scope",
        ),
        sa.Column(
            "previous_execution_id",
            big_integer_id_type(),
            nullable=False,
            server_default="0",
            comment="Previous attempt id; 0 means none",
        ),
        sa.Column(
            "execution_scope",
            sa.String(160),
            nullable=False,
            server_default="",
            comment="Concurrency and retry scope for the execution",
        ),
        sa.Column(
            "observed_state",
            sa.String(24),
            nullable=False,
            server_default="unconfirmed",
            comment="Latest verified Runtime state",
        ),
        sa.Column(
            "sync_state",
            sa.String(16),
            nullable=False,
            server_default="pending",
            comment="Runtime observation freshness and consistency",
        ),
        sa.Column(
            "claimed_at",
            sa.DateTime(),
            nullable=False,
            server_default=UNSET_DATETIME,
            comment="Queue claim time; epoch means unset",
        ),
        sa.Column(
            "start_requested_at",
            sa.DateTime(),
            nullable=False,
            server_default=UNSET_DATETIME,
            comment="Time a Runtime start command may have been delivered",
        ),
        sa.Column(
            "observed_at",
            sa.DateTime(),
            nullable=False,
            server_default=UNSET_DATETIME,
            comment="Last verified Runtime observation time",
        ),
        sa.Column(
            "cancel_requested_at",
            sa.DateTime(),
            nullable=False,
            server_default=UNSET_DATETIME,
            comment="Cancellation intent time; epoch means unset",
        ),
        sa.Column(
            "last_event_seq",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Greatest accepted Runtime event sequence",
        ),
        sa.Column(
            "termination_reason",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Machine-readable terminal reason",
        ),
    )
    for column in columns:
        op.add_column("loop_item_executions", column)


def _backfill_truth_columns() -> None:
    connection = op.get_bind()
    dialect = connection.dialect.name
    runtime_task_expression = (
        "'codex-queue-' || id" if dialect == "sqlite" else "CONCAT('codex-queue-', id)"
    )
    scope_expression = (
        "CASE WHEN COALESCE(agent_id, '') <> '' "
        "THEN 'project_robot:' || loop_item_id "
        "WHEN COALESCE(automation_run_id, '') <> '' "
        "THEN 'automation_manager:' || automation_run_id "
        "ELSE 'automation_manager:' || id END"
        if dialect == "sqlite"
        else "CASE WHEN COALESCE(agent_id, '') <> '' "
        "THEN CONCAT('project_robot:', loop_item_id) "
        "WHEN COALESCE(automation_run_id, '') <> '' "
        "THEN CONCAT('automation_manager:', automation_run_id) "
        "ELSE CONCAT('automation_manager:', id) END"
    )
    op.execute(
        sa.text(
            "UPDATE loop_item_executions "
            f"SET runtime_task_id = {runtime_task_expression} "
            "WHERE COALESCE(runtime_task_id, '') = ''"
        )
    )
    op.execute(
        sa.text(
            "UPDATE loop_item_executions SET "
            "attempt_no = COALESCE(retry_attempt, 0) + 1, "
            f"execution_scope = {scope_expression}, "
            "observed_state = CASE status "
            "WHEN 'running' THEN 'running' "
            "WHEN 'completed' THEN 'succeeded' "
            "WHEN 'failed' THEN 'failed' "
            "WHEN 'cancelled' THEN 'cancelled' "
            "ELSE 'unconfirmed' END, "
            "sync_state = CASE "
            "WHEN status IN ('completed', 'failed', 'cancelled') THEN 'in_sync' "
            "WHEN status = 'running' THEN 'stale' "
            "ELSE 'pending' END, "
            "claimed_at = CASE "
            f"WHEN started_at > '{UNSET_DATETIME}' THEN started_at "
            f"ELSE '{UNSET_DATETIME}' END, "
            "start_requested_at = CASE "
            "WHEN status IN ('running', 'completed', 'failed') "
            f"AND started_at > '{UNSET_DATETIME}' THEN started_at "
            f"ELSE '{UNSET_DATETIME}' END, "
            "observed_at = CASE "
            "WHEN status IN ('completed', 'failed', 'cancelled') "
            f"AND completed_at > '{UNSET_DATETIME}' THEN completed_at "
            "WHEN status = 'running' "
            f"AND heartbeat_at > '{UNSET_DATETIME}' THEN heartbeat_at "
            f"ELSE '{UNSET_DATETIME}' END"
        )
    )


def upgrade() -> None:
    _add_truth_columns()
    _backfill_truth_columns()
    op.create_index(
        "idx_exec_scope_status",
        "loop_item_executions",
        ["execution_scope", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_exec_scope_status", table_name="loop_item_executions")
    for column in (
        "termination_reason",
        "last_event_seq",
        "cancel_requested_at",
        "observed_at",
        "start_requested_at",
        "claimed_at",
        "sync_state",
        "observed_state",
        "execution_scope",
        "previous_execution_id",
        "attempt_no",
    ):
        op.drop_column("loop_item_executions", column)
