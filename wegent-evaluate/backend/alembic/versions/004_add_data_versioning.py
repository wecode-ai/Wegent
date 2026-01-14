"""Add data versioning support

Revision ID: 004
Revises: 003
Create Date: 2026-01-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create data_versions table
    op.create_table(
        "data_versions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(50), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_sync_time", sa.DateTime(), nullable=True),
        sa.Column("sync_count", sa.Integer(), default=0, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    # Add version_id to conversation_records
    op.add_column(
        "conversation_records",
        sa.Column("version_id", sa.BigInteger(), nullable=True),
    )

    # Add version_id to evaluation_results
    op.add_column(
        "evaluation_results",
        sa.Column("version_id", sa.BigInteger(), nullable=True),
    )

    # Add version_id to sync_jobs
    op.add_column(
        "sync_jobs",
        sa.Column("version_id", sa.BigInteger(), nullable=True),
    )

    # Create initial version with existing data count
    op.execute(
        """
        INSERT INTO data_versions (id, name, description, created_at, sync_count)
        SELECT 1, '版本1', '初始版本 - 自动迁移创建', NOW(), COUNT(*)
        FROM conversation_records
        """
    )

    # Update existing records to use version 1
    op.execute("UPDATE conversation_records SET version_id = 1 WHERE version_id IS NULL")
    op.execute("UPDATE evaluation_results SET version_id = 1 WHERE version_id IS NULL")
    op.execute("UPDATE sync_jobs SET version_id = 1 WHERE version_id IS NULL")

    # Now make version_id NOT NULL for conversation_records and evaluation_results
    op.alter_column(
        "conversation_records",
        "version_id",
        existing_type=sa.BigInteger(),
        nullable=False,
    )
    op.alter_column(
        "evaluation_results",
        "version_id",
        existing_type=sa.BigInteger(),
        nullable=False,
    )

    # Create indexes for version_id
    op.create_index(
        "idx_cr_version_id",
        "conversation_records",
        ["version_id"],
    )
    op.create_index(
        "idx_er_version_id",
        "evaluation_results",
        ["version_id"],
    )
    op.create_index(
        "idx_sj_version_id",
        "sync_jobs",
        ["version_id"],
    )

    # Create foreign key constraints
    op.create_foreign_key(
        "fk_cr_version_id",
        "conversation_records",
        "data_versions",
        ["version_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_er_version_id",
        "evaluation_results",
        "data_versions",
        ["version_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_sj_version_id",
        "sync_jobs",
        "data_versions",
        ["version_id"],
        ["id"],
    )


def downgrade() -> None:
    # Drop foreign key constraints
    op.drop_constraint("fk_sj_version_id", "sync_jobs", type_="foreignkey")
    op.drop_constraint("fk_er_version_id", "evaluation_results", type_="foreignkey")
    op.drop_constraint("fk_cr_version_id", "conversation_records", type_="foreignkey")

    # Drop indexes
    op.drop_index("idx_sj_version_id", table_name="sync_jobs")
    op.drop_index("idx_er_version_id", table_name="evaluation_results")
    op.drop_index("idx_cr_version_id", table_name="conversation_records")

    # Drop version_id columns
    op.drop_column("sync_jobs", "version_id")
    op.drop_column("evaluation_results", "version_id")
    op.drop_column("conversation_records", "version_id")

    # Drop data_versions table
    op.drop_table("data_versions")
