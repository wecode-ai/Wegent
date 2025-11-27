"""add skill binaries table for skill management

Revision ID: 1a2b3c4d5e6f
Revises: 0c086b93f8b9
Create Date: 2025-01-26 12:00:00.000000+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1a2b3c4d5e6f'
down_revision: Union[str, Sequence[str], None] = '0c086b93f8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add skill_binaries table for storing Skill ZIP packages."""

    # Create skill_binaries table
    op.execute("""
    CREATE TABLE IF NOT EXISTS skill_binaries (
        id INT NOT NULL AUTO_INCREMENT,
        kind_id INT NOT NULL,
        binary_data LONGBLOB NOT NULL,
        file_size INT NOT NULL,
        file_hash VARCHAR(64) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY (kind_id),
        KEY ix_skill_binaries_id (id),
        CONSTRAINT fk_skill_binaries_kind_id FOREIGN KEY (kind_id)
            REFERENCES kinds (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)


def downgrade() -> None:
    """Remove skill_binaries table."""
    op.execute("DROP TABLE IF EXISTS skill_binaries")
