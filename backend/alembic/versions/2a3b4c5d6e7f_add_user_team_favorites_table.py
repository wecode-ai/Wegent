# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add_user_team_favorites_table

Revision ID: 2a3b4c5d6e7f
Revises: 1a2b3c4d5e6f
Create Date: 2025-07-16 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '2a3b4c5d6e7f'
down_revision = '1a2b3c4d5e6f'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create user_team_favorites table
    op.create_table(
        'user_team_favorites',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('team_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        mysql_charset='utf8mb4',
        mysql_collate='utf8mb4_unicode_ci'
    )
    op.create_index('ix_user_team_favorites_id', 'user_team_favorites', ['id'], unique=False)
    op.create_index('ix_user_team_favorites_user_id', 'user_team_favorites', ['user_id'], unique=False)
    op.create_index('ix_user_team_favorites_team_id', 'user_team_favorites', ['team_id'], unique=False)
    op.create_index('idx_user_team_favorite', 'user_team_favorites', ['user_id', 'team_id'], unique=True)


def downgrade() -> None:
    op.drop_index('idx_user_team_favorite', table_name='user_team_favorites')
    op.drop_index('ix_user_team_favorites_team_id', table_name='user_team_favorites')
    op.drop_index('ix_user_team_favorites_user_id', table_name='user_team_favorites')
    op.drop_index('ix_user_team_favorites_id', table_name='user_team_favorites')
    op.drop_table('user_team_favorites')
