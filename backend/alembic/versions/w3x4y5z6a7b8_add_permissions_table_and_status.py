# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add permissions table for knowledge base sharing and add status column

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2026-01-29

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
    """Upgrade schema."""

    # 1. Create permissions table
    op.create_table(
        "permissions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind_id", sa.Integer(), nullable=False),
        sa.Column(
            "resource_type", sa.String(50), nullable=False, server_default="knowledge_base"
        ),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("permission_type", sa.String(20), nullable=False),
        sa.Column("granted_by_user_id", sa.Integer(), nullable=False),
        sa.Column("granted_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.Column(
            "status",
            sa.Enum('pending', 'approved', 'disallow', name='permissionstatus'),
            nullable=False,
            server_default='pending',
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "kind_id", "resource_type", "user_id", name="uq_permission_user_resource"
        ),
        comment="Permission authorization table for resource access control",
    )

    # Create indexes
    op.create_index("ix_permissions_kind_id", "permissions", ["kind_id"])
    op.create_index("ix_permissions_user_id", "permissions", ["user_id"])
    op.create_index("ix_permissions_kb_active", "permissions", ["kind_id", "is_active"])
    op.create_index("ix_permissions_status", "permissions", ["status"])

    # 2. Fix nullable columns in other tables

    # Skip shared_tasks.copied_task_id (kept as nullable=True, default=None to represent "not yet copied")

    # system_config.updated_by: nullable=True -> nullable=False, default=0
    op.execute(
        """
        UPDATE system_configs SET updated_by = 0 WHERE updated_by IS NULL;
        """
    )
    op.alter_column(
        'system_configs',
        'updated_by',
        nullable=False,
        server_default='0'
    )

    # knowledge_documents.summary: nullable=True -> nullable=False, default='{}'
    op.execute(
        """
        UPDATE knowledge_documents SET summary = '{}'::jsonb WHERE summary IS NULL;
        """
    )
    op.alter_column(
        'knowledge_documents',
        'summary',
        nullable=False,
        server_default='{}'
    )

    # namespace.display_name: nullable=True -> nullable=False, default=''
    op.execute(
        """
        UPDATE namespace SET display_name = '' WHERE display_name IS NULL;
        """
    )
    op.alter_column(
        'namespace',
        'display_name',
        nullable=False,
        server_default=''
    )

    # wiki_projects.source_id: nullable=True -> nullable=False, default=''
    op.execute(
        """
        UPDATE wiki_projects SET source_id = '' WHERE source_id IS NULL;
        """
    )
    op.alter_column(
        'wiki_projects',
        'source_id',
        nullable=False,
        server_default=''
    )

    # wiki_projects.source_domain: nullable=True -> nullable=False, default=''
    op.execute(
        """
        UPDATE wiki_projects SET source_domain = '' WHERE source_domain IS NULL;
        """
    )
    op.alter_column(
        'wiki_projects',
        'source_domain',
        nullable=False,
        server_default=''
    )

    # 3. Add is_company column to namespace table
    op.add_column(
        'namespace',
        sa.Column(
            'is_company',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false()
        )
    )
    op.create_index('ix_namespace_is_company', 'namespace', ['is_company'])


def downgrade() -> None:
    """Downgrade schema."""

    # Revert is_company column
    op.drop_index('ix_namespace_is_company', table_name='namespace')
    op.drop_column('namespace', 'is_company')

    # Revert nullable changes for wiki_projects
    op.alter_column(
        'wiki_projects',
        'source_domain',
        nullable=True,
        server_default=None
    )
    op.alter_column(
        'wiki_projects',
        'source_id',
        nullable=True,
        server_default=None
    )

    # Revert nullable changes for namespace
    op.alter_column(
        'namespace',
        'display_name',
        nullable=True,
        server_default=None
    )

    # Revert nullable changes for knowledge_documents
    op.alter_column(
        'knowledge_documents',
        'summary',
        nullable=True,
        server_default=None
    )

    # Revert nullable changes for system_config
    op.alter_column(
        'system_configs',
        'updated_by',
        nullable=True,
        server_default=None
    )

    # Revert nullable changes for shared_tasks
    op.alter_column(
        'shared_tasks',
        'copied_task_id',
        nullable=True,
        server_default=None
    )

    # Drop indexes
    op.drop_index("ix_permissions_status", table_name="permissions")
    op.drop_index("ix_permissions_kb_active", table_name="permissions")
    op.drop_index("ix_permissions_user_id", table_name="permissions")
    op.drop_index("ix_permissions_kind_id", table_name="permissions")

    # Drop table
    op.drop_table("permissions")
    op.execute('DROP TYPE IF EXISTS permissionstatus')
