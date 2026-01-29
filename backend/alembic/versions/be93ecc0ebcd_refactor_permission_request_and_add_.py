"""Refactor permission request to use permission table and add is_company to namespace

This migration:
1. Adds status, request_reason, and response_message columns to permissions table
2. Adds is_company column to namespace table
3. Drops permission_requests table (functionality moved to permissions table)

Revision ID: be93ecc0ebcd
Revises: x4y5z6a7b8c9
Create Date: 2026-01-29 17:37:26.908263+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'be93ecc0ebcd'
down_revision: Union[str, Sequence[str], None] = 'x4y5z6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""

    # Create permissionstatus enum type
    op.execute(
        "CREATE TYPE permissionstatus AS ENUM ('pending', 'approved', 'disallow')"
    )

    # Add status column to permissions table
    op.add_column(
        'permissions',
        sa.Column(
            'status',
            sa.Enum('pending', 'approved', 'disallow', name='permissionstatus'),
            nullable=False,
            server_default='approved'
        )
    )

    # Add request_reason column to permissions table
    op.add_column(
        'permissions',
        sa.Column('request_reason', sa.String(1000), nullable=False, server_default='')
    )

    # Add response_message column to permissions table
    op.add_column(
        'permissions',
        sa.Column('response_message', sa.String(500), nullable=False, server_default='')
    )

    # Add is_company column to namespace table
    op.add_column(
        'namespace',
        sa.Column('is_company', sa.Boolean(), nullable=False, server_default='false')
    )

    # Update namespace display_name to be not nullable with default
    op.alter_column(
        'namespace',
        'display_name',
        nullable=False,
        server_default=''
    )

    # Drop permission_requests table
    op.drop_table('permission_requests')

    # Drop permissionrequeststatus enum type
    op.execute('DROP TYPE IF EXISTS permissionrequeststatus')


def downgrade() -> None:
    """Downgrade schema."""

    # Recreate permission_requests table
    op.create_table(
        'permission_requests',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('kind_id', sa.Integer(), nullable=False),
        sa.Column(
            'resource_type',
            sa.String(50),
            nullable=False,
            server_default='knowledge_base',
        ),
        sa.Column('applicant_user_id', sa.Integer(), nullable=False),
        sa.Column(
            'requested_permission_type',
            sa.String(20),
            nullable=False,
            server_default='read',
        ),
        sa.Column('request_reason', sa.Text(), nullable=True),
        sa.Column(
            'status',
            sa.Enum(
                'pending',
                'approved',
                'rejected',
                'cancelled',
                'expired',
                name='permissionrequeststatus',
            ),
            nullable=False,
            server_default='pending',
        ),
        sa.Column('processed_by_user_id', sa.Integer(), nullable=True),
        sa.Column('processed_at', sa.DateTime(), nullable=True),
        sa.Column('response_message', sa.Text(), nullable=True),
        sa.Column(
            'created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint('id'),
        comment='Permission request table for resource access approval workflow',
    )

    # Create indexes for permission_requests
    op.create_index(
        'ix_permission_requests_kind_id', 'permission_requests', ['kind_id']
    )
    op.create_index(
        'ix_permission_requests_applicant_user_id',
        'permission_requests',
        ['applicant_user_id'],
    )
    op.create_index(
        'ix_permission_requests_kb_status', 'permission_requests', ['kind_id', 'status']
    )
    op.create_index(
        'ix_permission_requests_applicant',
        'permission_requests',
        ['applicant_user_id', 'status'],
    )

    # Drop columns from permissions table
    op.drop_column('permissions', 'response_message')
    op.drop_column('permissions', 'request_reason')
    op.drop_column('permissions', 'status')

    # Drop is_company column from namespace table
    op.drop_column('namespace', 'is_company')

    # Revert namespace display_name to nullable
    op.alter_column('namespace', 'display_name', nullable=True)

    # Drop permissionstatus enum type
    op.execute('DROP TYPE IF EXISTS permissionstatus')
