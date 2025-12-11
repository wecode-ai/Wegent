# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Alter wiki tables columns to match new schema

Revision ID: f6a7b8c9d0e1
Revises: c3d4e5f6a7b8
Create Date: 2025-12-09 17:00:00.000000+08:00

This migration modifies wiki tables to match the new schema:

wiki_projects:
- description: Change from nullable to NOT NULL
- ext: Remove DEFAULT (JSON_OBJECT())

wiki_generations:
- task_id: Change from nullable to NOT NULL DEFAULT 0
- source_snapshot: Remove DEFAULT (JSON_OBJECT())
- ext: Remove DEFAULT (JSON_OBJECT())
- completed_at: Change from nullable to NOT NULL DEFAULT '1970-01-01 00:00:00'

wiki_contents:
- content: Change from nullable to NOT NULL
- ext: Remove DEFAULT (JSON_OBJECT())
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Modify wiki tables columns to match new schema."""

    # ========== wiki_projects ==========
    # Update NULL description values to empty string before adding NOT NULL constraint
    op.execute(
        """
        UPDATE wiki_projects SET description = '' WHERE description IS NULL
        """
    )

    # Change description column to NOT NULL
    op.execute(
        """
        ALTER TABLE wiki_projects MODIFY COLUMN description TEXT NOT NULL COMMENT 'Project description'
        """
    )

    # Change ext column to remove default value (keep NOT NULL)
    op.execute(
        """
        ALTER TABLE wiki_projects MODIFY COLUMN ext JSON NOT NULL COMMENT 'Project extension data'
        """
    )

    # ========== wiki_generations ==========
    # Update NULL task_id values to 0 before adding NOT NULL constraint
    op.execute(
        """
        UPDATE wiki_generations SET task_id = 0 WHERE task_id IS NULL
        """
    )

    # Change task_id column to NOT NULL DEFAULT 0
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN task_id INT NOT NULL DEFAULT 0 COMMENT 'Associated task ID'
        """
    )

    # Change source_snapshot column to remove default value (keep NOT NULL)
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN source_snapshot JSON NOT NULL COMMENT 'Source snapshot information including branch, commit, etc'
        """
    )

    # Change ext column to remove default value (keep NOT NULL)
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN ext JSON NOT NULL COMMENT 'Extension fields for additional metadata'
        """
    )

    # Update NULL completed_at values to default timestamp before adding NOT NULL constraint
    op.execute(
        """
        UPDATE wiki_generations SET completed_at = '1970-01-01 00:00:00' WHERE completed_at IS NULL
        """
    )

    # Change completed_at column to NOT NULL with default
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN completed_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Generation completion time'
        """
    )

    # ========== wiki_contents ==========
    # Update NULL content values to empty string before adding NOT NULL constraint
    op.execute(
        """
        UPDATE wiki_contents SET content = '' WHERE content IS NULL
        """
    )

    # Change content column to NOT NULL
    op.execute(
        """
        ALTER TABLE wiki_contents MODIFY COLUMN content LONGTEXT NOT NULL COMMENT 'Content body in markdown format'
        """
    )

    # Change ext column to remove default value (keep NOT NULL)
    op.execute(
        """
        ALTER TABLE wiki_contents MODIFY COLUMN ext JSON NOT NULL COMMENT 'Content extension data'
        """
    )


def downgrade() -> None:
    """Revert wiki tables columns to original schema."""

    # ========== wiki_contents ==========
    # Change content column back to nullable
    op.execute(
        """
        ALTER TABLE wiki_contents MODIFY COLUMN content LONGTEXT DEFAULT NULL COMMENT 'Content body in markdown format'
        """
    )

    # Change ext column back to NOT NULL with default
    op.execute(
        """
        ALTER TABLE wiki_contents MODIFY COLUMN ext JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Content extension data'
        """
    )

    # ========== wiki_generations ==========
    # Change completed_at column back to nullable
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN completed_at DATETIME DEFAULT NULL COMMENT 'Generation completion time'
        """
    )

    # Change ext column back to NOT NULL with default
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN ext JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Extension fields for additional metadata'
        """
    )

    # Change source_snapshot column back to NOT NULL with default
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN source_snapshot JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Source snapshot information including branch, commit, etc'
        """
    )

    # Change task_id column back to nullable
    op.execute(
        """
        ALTER TABLE wiki_generations MODIFY COLUMN task_id INT DEFAULT NULL COMMENT 'Associated task ID'
        """
    )

    # ========== wiki_projects ==========
    # Change ext column back to NOT NULL with default
    op.execute(
        """
        ALTER TABLE wiki_projects MODIFY COLUMN ext JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Project extension data'
        """
    )

    # Change description column back to nullable
    op.execute(
        """
        ALTER TABLE wiki_projects MODIFY COLUMN description TEXT DEFAULT NULL COMMENT 'Project description'
        """
    )