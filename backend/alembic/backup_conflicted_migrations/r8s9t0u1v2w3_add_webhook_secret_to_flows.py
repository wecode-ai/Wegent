# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Add webhook_secret column to flows table for HMAC signature verification.

Revision ID: r8s9t0u1v2w3
Revises: q7r8s9t0u1v2
Create Date: 2025-01-15 10:00:00.000000

This migration adds the webhook_secret column to the flows table to support
HMAC-SHA256 signature verification for webhook triggers.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "r8s9t0u1v2w3"
down_revision = "q7r8s9t0u1v2"
branch_labels = None
depends_on = None


def upgrade():
    """Add webhook_secret column to flows table."""
    op.add_column(
        "flows",
        sa.Column("webhook_secret", sa.String(255), nullable=True),
    )


def downgrade():
    """Remove webhook_secret column from flows table."""
    op.drop_column("flows", "webhook_secret")
