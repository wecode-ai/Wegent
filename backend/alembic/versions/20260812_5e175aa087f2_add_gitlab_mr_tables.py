# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add gitlab mr integration tables

Revision ID: 5e175aa087f2
Revises: 735edcb17bec
Create Date: 2026-08-12

Adds the MR webhook registration and per-MR fix-task state tables backing the
GitLab MR review -> kanban fix-task loop.

Schema follows production DB audit rules: every column has COMMENT, non-PK
columns are NOT NULL with explicit DEFAULT (JSON columns intentionally omit
DEFAULT per DBA guidance; the app always writes []/{}), no ENUM, no foreign
keys, unique indexes use uniq_ prefix, and optional values use sentinels
(0 / '' / 1970-01-01 00:00:00.000000).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "5e175aa087f2"
down_revision: Union[str, Sequence[str], None] = "735edcb17bec"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_EPOCH = "1970-01-01 00:00:00.000000"


def _bigint() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer, "sqlite")


def _datetime() -> sa.types.TypeEngine:
    return sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def upgrade() -> None:
    op.create_table(
        "mr_integrations",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="MR integration primary key",
        ),
        sa.Column(
            "cloud_project_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Owning cloud project loop_items id",
        ),
        sa.Column(
            "project_key",
            sa.String(16),
            nullable=False,
            server_default="",
            comment="Denormalized project key used to build card item ids",
        ),
        sa.Column(
            "repository",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="GitLab path_with_namespace, e.g. group/project",
        ),
        sa.Column(
            "domain",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="GitLab host domain",
        ),
        sa.Column(
            "api_base",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="GitLab API base URL",
        ),
        sa.Column(
            "webhook_token",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="URL path token routing inbound webhooks to this registration",
        ),
        sa.Column(
            "webhook_secret",
            sa.String(128),
            nullable=False,
            server_default="",
            comment="Shared secret compared against X-Gitlab-Token header",
        ),
        sa.Column(
            "gitlab_hook_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="GitLab project hook id; 0 means not installed",
        ),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Whether inbound webhook processing is active",
        ),
        sa.Column(
            "status",
            sa.String(32),
            nullable=False,
            server_default="",
            comment="ok / hook_missing / error",
        ),
        sa.Column(
            "last_error",
            sa.String(1000),
            nullable=False,
            server_default="",
            comment="Last error message; empty means no error",
        ),
        sa.Column(
            "last_reconcile_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Last reconcile time; epoch means never reconciled",
        ),
        sa.Column(
            "created_by_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="User who enabled the integration; assignee fallback",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last update time",
        ),
        sa.UniqueConstraint("cloud_project_id", name="uniq_mr_integrations_project"),
        sa.UniqueConstraint("webhook_token", name="uniq_mr_integrations_webhook_token"),
        comment="GitLab MR webhook registration per cloud project",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index("idx_mr_integrations_enabled", "mr_integrations", ["enabled"])

    op.create_table(
        "mr_records",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="MR record primary key",
        ),
        sa.Column(
            "integration_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Owning mr_integrations id",
        ),
        sa.Column(
            "mr_iid",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="GitLab merge request iid",
        ),
        sa.Column(
            "project_key",
            sa.String(16),
            nullable=False,
            server_default="",
            comment="Denormalized project key used to build card item ids",
        ),
        sa.Column(
            "source_branch",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="MR source branch",
        ),
        sa.Column(
            "target_branch",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="MR target branch",
        ),
        sa.Column(
            "author_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="GitLab author user id",
        ),
        sa.Column(
            "mr_title",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="MR title",
        ),
        sa.Column(
            "state",
            sa.String(16),
            nullable=False,
            server_default="evaluating",
            comment="evaluating / actionable / clean / closed",
        ),
        sa.Column(
            "head_sha",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Head commit sha of the current round",
        ),
        sa.Column(
            "round_number",
            _bigint(),
            nullable=False,
            server_default="1",
            comment="Current fix round; increments on each head change",
        ),
        sa.Column(
            "pipeline_status",
            sa.String(24),
            nullable=False,
            server_default="pending",
            comment="Latest pipeline status for the head sha",
        ),
        sa.Column(
            "pipeline_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Latest pipeline id; 0 means none",
        ),
        sa.Column(
            "current_loop_item_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Board card loop_items id; empty when no card",
        ),
        sa.Column(
            "auto_retrigger_count",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Times the state machine auto-re-triggered a robot run on new feedback; capped by project ai_automation",
        ),
        sa.Column(
            "seen_note_ids",
            sa.JSON(),
            nullable=False,
            comment="Note ids the last robot run saw at dispatch; others are pending",
        ),
        sa.Column(
            "snapshot_json",
            sa.JSON(),
            nullable=False,
            comment="Current MR snapshot JSON object; app writes {} when unset",
        ),
        sa.Column(
            "rounds_json",
            sa.JSON(),
            nullable=False,
            comment="Append-only round history JSON array; app writes [] when unset",
        ),
        sa.Column(
            "version",
            _bigint(),
            nullable=False,
            server_default="1",
            comment="Optimistic lock version",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last update time",
        ),
        sa.Column(
            "closed_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Close time; epoch means not closed",
        ),
        sa.UniqueConstraint(
            "integration_id", "mr_iid", name="uniq_mr_records_integration_iid"
        ),
        comment="Per-MR fix-task state across webhook events",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_mr_records_reconcile",
        "mr_records",
        ["integration_id", "state", "head_sha"],
    )
    op.create_index(
        "idx_mr_records_pipeline_lookup",
        "mr_records",
        ["integration_id", "head_sha", "round_number"],
    )


def downgrade() -> None:
    op.drop_index("idx_mr_records_pipeline_lookup", table_name="mr_records")
    op.drop_index("idx_mr_records_reconcile", table_name="mr_records")
    op.drop_table("mr_records")
    op.drop_index("idx_mr_integrations_enabled", table_name="mr_integrations")
    op.drop_table("mr_integrations")
