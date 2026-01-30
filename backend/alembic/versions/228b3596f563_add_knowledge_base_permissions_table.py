"""add_knowledge_base_permissions_table

Revision ID: 228b3596f563
Revises: w3x4y5z6a7b8
Create Date: 2026-01-30 16:52:12.082384+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '228b3596f563'
down_revision: Union[str, Sequence[str], None] = 'w3x4y5z6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'knowledge_base_permissions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('knowledge_base_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('permission_level', sa.String(length=20), nullable=False),
        sa.Column('approval_status', sa.String(length=20), nullable=False, server_default='pending'),
        sa.Column('requested_by', sa.Integer(), nullable=False),
        sa.Column('approved_by', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')),
        sa.Index('ix_kb_permissions_kb_user', 'knowledge_base_id', 'user_id'),
        sa.Index('ix_kb_permissions_status', 'approval_status'),
        mysql_engine='InnoDB',
        mysql_charset='utf8mb4',
        mysql_collate='utf8mb4_unicode_ci',
        comment='Knowledge base permission table for access requests and permissions'
    )
    op.create_index(op.f('ix_knowledge_base_permissions_id'), 'knowledge_base_permissions', ['id'], unique=False)
    op.create_index(op.f('ix_knowledge_base_permissions_knowledge_base_id'), 'knowledge_base_permissions', ['knowledge_base_id'], unique=False)
    op.create_index(op.f('ix_knowledge_base_permissions_user_id'), 'knowledge_base_permissions', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_knowledge_base_permissions_user_id'), table_name='knowledge_base_permissions')
    op.drop_index(op.f('ix_knowledge_base_permissions_knowledge_base_id'), table_name='knowledge_base_permissions')
    op.drop_index(op.f('ix_knowledge_base_permissions_id'), table_name='knowledge_base_permissions')
    op.drop_table('knowledge_base_permissions')
