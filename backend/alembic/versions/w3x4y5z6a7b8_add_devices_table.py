# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add devices table for local device support

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2025-01-28

This migration creates the 'devices' table for storing local device information.
Devices can execute tasks as an alternative to cloud Docker containers.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "w3x4y5z6a7b8"
down_revision: Union[str, None] = "v2w3x4y5z6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create devices table."""
    op.create_table(
        "devices",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "user_id", sa.Integer(), nullable=False, comment="Device owner user ID"
        ),
        sa.Column(
            "name",
            sa.String(100),
            nullable=False,
            comment="Device name (self-provided)",
        ),
        sa.Column(
            "device_id",
            sa.String(100),
            nullable=False,
            comment="Device unique identifier (self-generated, e.g., MAC/UUID)",
        ),
        sa.Column(
            "status",
            sa.Enum("online", "offline", "busy", name="devicestatus"),
            nullable=False,
            server_default="offline",
            comment="Device status",
        ),
        sa.Column(
            "last_heartbeat",
            sa.DateTime(),
            nullable=True,
            comment="Last heartbeat time",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        comment="Local devices table for task execution",
    )

    # Create indices
    op.create_index("idx_device_user_id", "devices", ["user_id"])
    op.create_index("idx_device_device_id", "devices", ["device_id"])
    op.create_index("idx_device_status", "devices", ["status"])
    op.create_index(
        "uniq_user_device", "devices", ["user_id", "device_id"], unique=True
    )


def downgrade() -> None:
    """Drop devices table."""
    op.drop_index("uniq_user_device", table_name="devices")
    op.drop_index("idx_device_status", table_name="devices")
    op.drop_index("idx_device_device_id", table_name="devices")
    op.drop_index("idx_device_user_id", table_name="devices")
    op.drop_table("devices")
    # Drop the enum type
    op.execute("DROP TYPE IF EXISTS devicestatus")
