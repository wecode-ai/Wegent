"""remove_is_company_from_namespace_and_add_org_knowledge_namespace

Revision ID: ff4852b2a6fd
Revises: w3x4y5z6a7b8
Create Date: 2026-01-30 12:22:23.214408+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ff4852b2a6fd'
down_revision: Union[str, Sequence[str], None] = 'w3x4y5z6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Remove is_company column from namespace table
    op.drop_index('ix_namespace_is_company', table_name='namespace')
    op.drop_column('namespace', 'is_company')

    # Create organization_knowledge namespace record
    # Get admin user ID (user with username 'admin')
    from sqlalchemy import select
    from app.models.user import User
    from app.db.session import engine
    from sqlalchemy.orm import Session

    # Create a new session for the migration
    session = Session(engine)

    try:
        admin_user = session.execute(
            select(User.id).where(User.user_name == 'admin')
        ).scalar_one_or_none()

        if admin_user:
            # Check if organization_knowledge namespace already exists
            from app.models.namespace import Namespace
            existing_ns = session.execute(
                select(Namespace.id).where(Namespace.name == 'organization_knowledge')
            ).scalar_one_or_none()

            if not existing_ns:
                # Create organization_knowledge namespace
                op.execute(
                    """INSERT INTO namespace (name, display_name, owner_user_id, visibility, description, is_active, created_at, updated_at)
                    VALUES ('organization_knowledge', 'company knowledge base', %s, 'private', '', 1, NOW(), NOW())""",
                    (admin_user,)
                )
    except Exception as e:
        print(f"Warning: Failed to create organization_knowledge namespace: {e}")
    finally:
        session.close()


def downgrade() -> None:
    """Downgrade schema."""
    # Add back is_company column (for rollback purposes)
    op.add_column(
        'namespace',
        sa.Column(
            'is_company',
            sa.Boolean(),
            nullable=False,
            default=False,
        )
    )
    op.create_index('ix_namespace_is_company', 'namespace', ['is_company'])

    # Remove organization_knowledge namespace
    op.execute("DELETE FROM namespace WHERE name = 'organization_knowledge'")
