# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Add version column to flow_executions table for optimistic locking.

Revision ID: s9t0u1v2w3x4
Revises: r8s9t0u1v2w3
Create Date: 2025-01-16 10:00:00.000000

This migration adds the version column to support optimistic locking
for concurrent updates to FlowExecution records.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "s9t0u1v2w3x4"
down_revision = "r8s9t0u1v2w3"
branch_labels = None
depends_on = None


def upgrade():
    """Add version column to flow_executions table."""
    op.add_column(
        "flow_executions",
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade():
    """Remove version column from flow_executions table."""
    op.drop_column("flow_executions", "version")
