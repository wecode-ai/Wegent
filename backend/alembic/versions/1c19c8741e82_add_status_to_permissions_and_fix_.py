# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add status to permissions and fix nullable columns

Revision ID: 1c19c8741e82
Revises: w3x4y5z6a7b8
Create Date: 2026-01-29

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1c19c8741e82'
down_revision: Union[str, Sequence[str], None] = 'w3x4y5z6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""

    # 1. Add status column to permissions table
    op.execute(
        """
        CREATE TYPE permissionstatus AS ENUM ('pending', 'approved', 'disallow');
        """
    )
    op.add_column(
        'permissions',
        sa.Column(
            'status',
            sa.Enum('pending', 'approved', 'disallow', name='permissionstatus'),
            nullable=False,
            server_default='pending',
        )
    )
    op.create_index('ix_permissions_status', 'permissions', ['status'])

    # 2. Fix granted_at column: set default and make non-nullable
    # First set default values for existing NULL rows
    op.execute(
        """
        UPDATE permissions SET granted_at = NOW() WHERE granted_at IS NULL;
        """
    )
    # Alter column to be NOT NULL with default
    op.alter_column(
        'permissions',
        'granted_at',
        nullable=False,
        server_default=sa.func.now()
    )

    # 3. Fix nullable columns in other tables

    # shared_tasks.kind_id: nullable=True -> nullable=False, default=0
    op.execute(
        """
        UPDATE shared_tasks SET copied_task_id = 0 WHERE copied_task_id IS NULL;
        """
    )
    op.alter_column(
        'shared_tasks',
        'copied_task_id',
        nullable=False,
        server_default='0'
    )

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

    # 4. Add is_company column to namespace table
    op.add_column(
        'namespace',
        sa.Column(
            'is_company',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false()
        )
    )
    op.create_index('ix_namespaces_is_company', 'namespace', ['is_company'])


def downgrade() -> None:
    """Downgrade schema."""

    # Revert is_company column
    op.drop_index('ix_namespaces_is_company', table_name='namespace')
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

    # Revert granted_at changes
    op.alter_column(
        'permissions',
        'granted_at',
        nullable=True,
        server_default=None
    )

    # Revert status column
    op.drop_index('ix_permissions_status', table_name='permissions')
    op.drop_column('permissions', 'status')
    op.execute('DROP TYPE IF EXISTS permissionstatus')
