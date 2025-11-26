"""add skill binaries table

Revision ID: a1b2c3d4e5f6
Revises: 0c086b93f8b9
Create Date: 2025-01-20 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = '0c086b93f8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add skill_binaries table for storing Skill ZIP packages."""

    op.execute("""
    CREATE TABLE IF NOT EXISTS skill_binaries (
        id INT NOT NULL AUTO_INCREMENT,
        kind_id INT NOT NULL,
        binary_data LONGBLOB NOT NULL COMMENT 'ZIP package binary data',
        file_size INT NOT NULL COMMENT 'File size in bytes',
        file_hash VARCHAR(64) NOT NULL COMMENT 'SHA256 hash',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY idx_skill_binary_kind_id (kind_id),
        CONSTRAINT fk_skill_binary_kind_id FOREIGN KEY (kind_id) REFERENCES kinds(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)


def downgrade() -> None:
    """Drop skill_binaries table."""
    op.drop_table('skill_binaries')
