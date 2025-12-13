# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add subscription tables for Smart Feed feature

Revision ID: i9j0k1l2m3n4
Revises: h8i9j0k1l2m3
Create Date: 2025-12-13 10:00:00.000000+08:00

This migration adds tables for the Smart Feed (Subscription) feature:
1. subscriptions - Main subscription configuration
2. subscription_items - Collected information items
3. subscription_runs - Execution history records
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "i9j0k1l2m3n4"
down_revision: Union[str, None] = "h8i9j0k1l2m3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create subscription tables."""
    from sqlalchemy import inspect

    bind = op.get_bind()

    def get_fresh_inspector():
        """Get a fresh inspector to avoid cache issues."""
        return inspect(bind)

    def table_exists(table_name: str) -> bool:
        """Check if table exists."""
        return table_name in get_fresh_inspector().get_table_names()

    def get_existing_indexes(table_name: str) -> set:
        """Get existing index names for a table (fresh query each time)."""
        try:
            indexes = get_fresh_inspector().get_indexes(table_name)
            return {idx["name"] for idx in indexes}
        except Exception:
            return set()

    def create_index_if_not_exists(index_name: str, table_name: str, columns: list):
        """Create index only if it doesn't exist."""
        existing_indexes = get_existing_indexes(table_name)
        if index_name not in existing_indexes:
            op.create_index(index_name, table_name, columns)

    # Create subscriptions table
    if not table_exists("subscriptions"):
        op.create_table(
            "subscriptions",
            sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
            sa.Column("user_id", sa.Integer(), nullable=False, index=True),
            sa.Column(
                "namespace", sa.String(100), nullable=False, server_default="default"
            ),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            # Team reference
            sa.Column("team_id", sa.Integer(), nullable=False),
            sa.Column("team_name", sa.String(100), nullable=False),
            sa.Column(
                "team_namespace",
                sa.String(100),
                nullable=False,
                server_default="default",
            ),
            # Trigger configuration
            sa.Column(
                "trigger_type", sa.String(20), nullable=False, server_default="cron"
            ),
            sa.Column("cron_expression", sa.String(100), nullable=True),
            sa.Column(
                "cron_timezone",
                sa.String(50),
                nullable=True,
                server_default="Asia/Shanghai",
            ),
            sa.Column("webhook_secret", sa.String(100), nullable=True),
            # Alert policy
            sa.Column("alert_enabled", sa.Boolean(), server_default="1"),
            sa.Column("alert_prompt", sa.Text(), nullable=True),
            sa.Column("alert_keywords", sa.JSON(), nullable=True),
            # Retention policy
            sa.Column("retention_days", sa.Integer(), server_default="30"),
            # Status
            sa.Column("enabled", sa.Boolean(), server_default="1"),
            sa.Column("last_run_time", sa.DateTime(), nullable=True),
            sa.Column("last_run_status", sa.String(20), nullable=True),
            sa.Column("unread_count", sa.Integer(), server_default="0"),
            sa.Column("total_item_count", sa.Integer(), server_default="0"),
            # Metadata
            sa.Column("is_active", sa.Boolean(), server_default="1"),
            sa.Column(
                "created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )

    # Create indexes for subscriptions (check existence for idempotency)
    create_index_if_not_exists("ix_subscriptions_id", "subscriptions", ["id"])
    create_index_if_not_exists("ix_subscriptions_user_id", "subscriptions", ["user_id"])
    create_index_if_not_exists(
        "ix_subscriptions_namespace", "subscriptions", ["namespace"]
    )
    create_index_if_not_exists("ix_subscriptions_enabled", "subscriptions", ["enabled"])

    # Create subscription_runs table (before subscription_items due to foreign key)
    if not table_exists("subscription_runs"):
        op.create_table(
            "subscription_runs",
            sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
            sa.Column(
                "subscription_id",
                sa.Integer(),
                sa.ForeignKey("subscriptions.id"),
                nullable=False,
                index=True,
            ),
            sa.Column("task_id", sa.Integer(), nullable=True),
            sa.Column(
                "status", sa.String(20), nullable=False, server_default="pending"
            ),
            sa.Column("items_collected", sa.Integer(), server_default="0"),
            sa.Column("items_alerted", sa.Integer(), server_default="0"),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )

    # Create indexes for subscription_runs
    create_index_if_not_exists("ix_subscription_runs_id", "subscription_runs", ["id"])
    create_index_if_not_exists(
        "ix_subscription_runs_subscription_id", "subscription_runs", ["subscription_id"]
    )
    create_index_if_not_exists(
        "ix_subscription_runs_status", "subscription_runs", ["status"]
    )

    # Create subscription_items table
    if not table_exists("subscription_items"):
        op.create_table(
            "subscription_items",
            sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
            sa.Column(
                "subscription_id",
                sa.Integer(),
                sa.ForeignKey("subscriptions.id"),
                nullable=False,
                index=True,
            ),
            sa.Column("title", sa.String(500), nullable=False),
            sa.Column("content", sa.Text(), nullable=True),
            sa.Column("summary", sa.Text(), nullable=True),
            sa.Column("source_url", sa.String(1000), nullable=True),
            sa.Column("item_metadata", sa.JSON(), nullable=True),
            # Alert status
            sa.Column("should_alert", sa.Boolean(), server_default="0"),
            sa.Column("alert_reason", sa.String(500), nullable=True),
            # Read status
            sa.Column("is_read", sa.Boolean(), server_default="0"),
            # References
            sa.Column("task_id", sa.Integer(), nullable=True),
            sa.Column(
                "run_id",
                sa.Integer(),
                sa.ForeignKey("subscription_runs.id"),
                nullable=True,
            ),
            # Metadata
            sa.Column(
                "created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )

    # Create indexes for subscription_items
    create_index_if_not_exists("ix_subscription_items_id", "subscription_items", ["id"])
    create_index_if_not_exists(
        "ix_subscription_items_subscription_id",
        "subscription_items",
        ["subscription_id"],
    )
    create_index_if_not_exists(
        "ix_subscription_items_is_read", "subscription_items", ["is_read"]
    )
    create_index_if_not_exists(
        "ix_subscription_items_should_alert", "subscription_items", ["should_alert"]
    )
    create_index_if_not_exists(
        "ix_subscription_items_created_at", "subscription_items", ["created_at"]
    )


def downgrade() -> None:
    """Drop subscription tables."""
    op.drop_table("subscription_items")
    op.drop_table("subscription_runs")
    op.drop_table("subscriptions")
