"""add device workspaces

Revision ID: f1a2b3c4d5e6
Revises: d5e6f7a8b9c0
Create Date: 2026-06-20 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "device_workspaces",
        sa.Column("id", sa.Integer(), nullable=False, comment="Primary key"),
        sa.Column("user_id", sa.Integer(), nullable=False, comment="Owner user ID"),
        sa.Column("project_id", sa.Integer(), nullable=False, comment="Project ID"),
        sa.Column(
            "device_id", sa.String(length=128), nullable=False, comment="Device ID"
        ),
        sa.Column(
            "workspace_path",
            sa.Text(),
            nullable=False,
            comment="Absolute workspace path on the local device",
        ),
        sa.Column(
            "repo_url", sa.Text(), nullable=True, comment="Optional repository URL"
        ),
        sa.Column(
            "repo_root_fingerprint",
            sa.String(length=128),
            nullable=True,
            comment="Optional local repository root fingerprint",
        ),
        sa.Column(
            "label",
            sa.String(length=255),
            nullable=True,
            comment="User-facing workspace label",
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(),
            nullable=True,
            comment="Last time the owning executor reported this workspace",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Creation timestamp",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            comment="Last update timestamp",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "device_id",
            "workspace_path",
            name="uq_device_workspace_user_device_path",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
        comment="Central mappings from Projects to device-local workspaces",
    )
    op.create_index(
        op.f("ix_device_workspaces_id"), "device_workspaces", ["id"], unique=False
    )
    op.create_index(
        op.f("ix_device_workspaces_user_id"),
        "device_workspaces",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_device_workspaces_project_id"),
        "device_workspaces",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_device_workspaces_device_id"),
        "device_workspaces",
        ["device_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_device_workspaces_device_id"), table_name="device_workspaces"
    )
    op.drop_index(
        op.f("ix_device_workspaces_project_id"), table_name="device_workspaces"
    )
    op.drop_index(op.f("ix_device_workspaces_user_id"), table_name="device_workspaces")
    op.drop_index(op.f("ix_device_workspaces_id"), table_name="device_workspaces")
    op.drop_table("device_workspaces")
