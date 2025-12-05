"""Add user role and system config table

Revision ID: add_role_and_system_config
Revises: a1b2c3d4e5f6_add_auth_source_to_users
Create Date: 2025-01-15 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_role_and_system_config'
down_revision = 'a1b2c3d4e5f6_add_auth_source_to_users'
branch_labels = None
depends_on = None


def upgrade():
    # Add role column to users table
    op.add_column('users', sa.Column('role', sa.String(20), nullable=False, server_default='user'))

    # Create system_config table
    op.create_table(
        'system_config',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('config_key', sa.String(100), nullable=False),
        sa.Column('config_value', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_system_config_config_key'), 'system_config', ['config_key'], unique=True)
    op.create_index(op.f('ix_system_config_id'), 'system_config', ['id'], unique=False)


def downgrade():
    # Drop system_config table
    op.drop_index(op.f('ix_system_config_id'), table_name='system_config')
    op.drop_index(op.f('ix_system_config_config_key'), table_name='system_config')
    op.drop_table('system_config')

    # Remove role column from users table
    op.drop_column('users', 'role')
