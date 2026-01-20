# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Rename Flow to Subscription

This migration:
1. Migrates data from flows table to kinds table (as Subscription kind)
2. Renames flow_executions table to background_executions
3. Renames flow_id column to subscription_id
4. Drops the flows table

Revision ID: u1v2w3x4y5z6
Revises: t0u1v2w3x4y5
Create Date: 2026-01-20 14:55:00.000000+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "u1v2w3x4y5z6"
down_revision: Union[str, Sequence[str], None] = "t0u1v2w3x4y5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Upgrade schema:
    1. Migrate flows data to kinds table as Subscription
    2. Rename flow_executions to background_executions
    3. Rename flow_id to subscription_id
    4. Drop flows table
    """
    conn = op.get_bind()

    # Step 1: Check if flows table exists and migrate data to kinds table
    # The flows table stores Flow resources with their own schema
    # We need to migrate them to kinds table as Subscription kind
    result = conn.execute(
        text(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'flows'"
        )
    )
    flows_exists = result.scalar() > 0

    if flows_exists:
        # Drop temporary mapping table if it exists from a previous failed migration
        conn.execute(text("DROP TABLE IF EXISTS _flow_to_subscription_mapping"))

        # Create a temporary mapping table to track old flow_id -> new kinds.id
        op.create_table(
            "_flow_to_subscription_mapping",
            sa.Column("old_flow_id", sa.Integer(), nullable=False),
            sa.Column("new_subscription_id", sa.Integer(), nullable=False),
        )

        # Migrate flows data to kinds table
        # Update the JSON to change kind from 'Flow' to 'Subscription'
        conn.execute(
            text(
                """
                INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
                SELECT
                    user_id,
                    'Subscription' as kind,
                    name,
                    namespace,
                    JSON_SET(json, '$.kind', 'Subscription') as json,
                    is_active,
                    created_at,
                    updated_at
                FROM flows
                """
            )
        )

        # Build the mapping table
        # This maps old flow IDs to new subscription IDs in kinds table
        # Use COLLATE to handle collation mismatch between tables
        conn.execute(
            text(
                """
                INSERT INTO _flow_to_subscription_mapping (old_flow_id, new_subscription_id)
                SELECT
                    f.id as old_flow_id,
                    k.id as new_subscription_id
                FROM flows f
                INNER JOIN kinds k ON
                    k.kind = 'Subscription'
                    AND k.user_id = f.user_id
                    AND k.name COLLATE utf8mb4_unicode_ci = f.name COLLATE utf8mb4_unicode_ci
                    AND k.namespace COLLATE utf8mb4_unicode_ci = f.namespace COLLATE utf8mb4_unicode_ci
                """
            )
        )

    # Step 2: Rename flow_executions table to background_executions
    op.rename_table("flow_executions", "background_executions")

    # Step 3: Rename flow_id column to subscription_id
    op.alter_column(
        "background_executions",
        "flow_id",
        new_column_name="subscription_id",
        existing_type=sa.Integer(),
        existing_nullable=False,
    )

    # Step 4: Update subscription_id values using the mapping table
    if flows_exists:
        conn.execute(
            text(
                """
                UPDATE background_executions be
                INNER JOIN _flow_to_subscription_mapping m ON be.subscription_id = m.old_flow_id
                SET be.subscription_id = m.new_subscription_id
                """
            )
        )

        # Drop the temporary mapping table
        op.drop_table("_flow_to_subscription_mapping")

    # Step 5: Update indexes - drop old indexes and create new ones
    # Drop old indexes
    op.drop_index("idx_flow_exec_flow_id", table_name="background_executions")
    op.drop_index("idx_flow_exec_flow_created", table_name="background_executions")

    # Create new indexes with updated names
    op.create_index(
        "idx_bg_exec_subscription_id",
        "background_executions",
        ["subscription_id"],
    )
    op.create_index(
        "idx_bg_exec_subscription_created",
        "background_executions",
        ["subscription_id", "created_at"],
    )

    # Rename other indexes for consistency
    op.drop_index("idx_flow_exec_user_id", table_name="background_executions")
    op.drop_index("idx_flow_exec_task_id", table_name="background_executions")
    op.drop_index("idx_flow_exec_status", table_name="background_executions")
    op.drop_index("idx_flow_exec_created_at", table_name="background_executions")
    op.drop_index("idx_flow_exec_user_created", table_name="background_executions")
    op.drop_index("idx_flow_exec_user_status", table_name="background_executions")

    op.create_index("idx_bg_exec_user_id", "background_executions", ["user_id"])
    op.create_index("idx_bg_exec_task_id", "background_executions", ["task_id"])
    op.create_index("idx_bg_exec_status", "background_executions", ["status"])
    op.create_index("idx_bg_exec_created_at", "background_executions", ["created_at"])
    op.create_index(
        "idx_bg_exec_user_created", "background_executions", ["user_id", "created_at"]
    )
    op.create_index(
        "idx_bg_exec_user_status", "background_executions", ["user_id", "status"]
    )

    # Step 6: Drop the flows table if it exists
    if flows_exists:
        op.drop_table("flows")


def downgrade() -> None:
    """
    Downgrade schema:
    1. Recreate flows table
    2. Migrate Subscription data back to flows table
    3. Rename background_executions back to flow_executions
    4. Rename subscription_id back to flow_id
    """
    conn = op.get_bind()

    # Step 1: Recreate flows table
    op.create_table(
        "flows",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(50), nullable=False, server_default="Flow"),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "namespace", sa.String(255), nullable=False, server_default="default"
        ),
        sa.Column("json", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("trigger_type", sa.String(50), nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("bound_task_id", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("webhook_token", sa.String(255), nullable=False, server_default=""),
        sa.Column("webhook_secret", sa.String(255), nullable=False, server_default=""),
        sa.Column(
            "last_execution_time",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "last_execution_status", sa.String(50), nullable=False, server_default=""
        ),
        sa.Column(
            "next_execution_time",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("execution_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("success_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failure_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for flows table
    op.create_index(
        "ix_flows_user_kind_name_ns",
        "flows",
        ["user_id", "kind", "name", "namespace"],
        unique=True,
    )
    op.create_index(
        "ix_flows_enabled_next_exec", "flows", ["enabled", "next_execution_time"]
    )
    op.create_index("ix_flows_user_active", "flows", ["user_id", "is_active"])

    # Step 2: Create mapping table for reverse migration
    op.create_table(
        "_subscription_to_flow_mapping",
        sa.Column("old_subscription_id", sa.Integer(), nullable=False),
        sa.Column("new_flow_id", sa.Integer(), nullable=False),
    )

    # Migrate Subscription data back to flows table
    # Note: This is a simplified migration - some fields may need manual adjustment
    conn.execute(
        text(
            """
            INSERT INTO flows (user_id, kind, name, namespace, json, is_active, trigger_type, team_id, created_at, updated_at)
            SELECT 
                user_id,
                'Flow' as kind,
                name,
                namespace,
                JSON_SET(json, '$.kind', 'Flow') as json,
                is_active,
                COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.trigger.type')), 'cron') as trigger_type,
                COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.teamRef.id')) AS UNSIGNED), 0) as team_id,
                created_at,
                updated_at
            FROM kinds
            WHERE kind = 'Subscription'
            """
        )
    )

    # Build reverse mapping
    conn.execute(
        text(
            """
            INSERT INTO _subscription_to_flow_mapping (old_subscription_id, new_flow_id)
            SELECT 
                k.id as old_subscription_id,
                f.id as new_flow_id
            FROM kinds k
            INNER JOIN flows f ON 
                f.user_id = k.user_id 
                AND f.name = k.name 
                AND f.namespace = k.namespace
            WHERE k.kind = 'Subscription'
            """
        )
    )

    # Step 3: Rename indexes back
    op.drop_index("idx_bg_exec_subscription_id", table_name="background_executions")
    op.drop_index(
        "idx_bg_exec_subscription_created", table_name="background_executions"
    )
    op.drop_index("idx_bg_exec_user_id", table_name="background_executions")
    op.drop_index("idx_bg_exec_task_id", table_name="background_executions")
    op.drop_index("idx_bg_exec_status", table_name="background_executions")
    op.drop_index("idx_bg_exec_created_at", table_name="background_executions")
    op.drop_index("idx_bg_exec_user_created", table_name="background_executions")
    op.drop_index("idx_bg_exec_user_status", table_name="background_executions")

    # Step 4: Rename subscription_id back to flow_id
    op.alter_column(
        "background_executions",
        "subscription_id",
        new_column_name="flow_id",
        existing_type=sa.Integer(),
        existing_nullable=False,
    )

    # Step 5: Update flow_id values using the mapping table
    conn.execute(
        text(
            """
            UPDATE background_executions be
            INNER JOIN _subscription_to_flow_mapping m ON be.flow_id = m.old_subscription_id
            SET be.flow_id = m.new_flow_id
            """
        )
    )

    # Drop the temporary mapping table
    op.drop_table("_subscription_to_flow_mapping")

    # Step 6: Rename background_executions back to flow_executions
    op.rename_table("background_executions", "flow_executions")

    # Recreate original indexes
    op.create_index("idx_flow_exec_user_id", "flow_executions", ["user_id"])
    op.create_index("idx_flow_exec_flow_id", "flow_executions", ["flow_id"])
    op.create_index("idx_flow_exec_task_id", "flow_executions", ["task_id"])
    op.create_index("idx_flow_exec_status", "flow_executions", ["status"])
    op.create_index("idx_flow_exec_created_at", "flow_executions", ["created_at"])
    op.create_index(
        "idx_flow_exec_user_created", "flow_executions", ["user_id", "created_at"]
    )
    op.create_index(
        "idx_flow_exec_flow_created", "flow_executions", ["flow_id", "created_at"]
    )
    op.create_index(
        "idx_flow_exec_user_status", "flow_executions", ["user_id", "status"]
    )

    # Step 7: Delete Subscription records from kinds table
    conn.execute(text("DELETE FROM kinds WHERE kind = 'Subscription'"))
