# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add projects table and project_id to tasks table

Revision ID: q7r8s9t0u1v2
Revises: p6q7r8s9t0u1
Create Date: 2026-01-12 11:30:00.000000+08:00

This migration adds support for project functionality:
1. Creates projects table to store project information
2. Adds project_id column to tasks table for one-to-many relationship
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "q7r8s9t0u1v2"
down_revision: Union[str, None] = "p6q7r8s9t0u1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create projects table and add project_id to tasks table."""
    from sqlalchemy import inspect

    conn = op.get_bind()
    inspector = inspect(conn)

    # Create projects table (already idempotent with IF NOT EXISTS)
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS projects (
        id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
        user_id INT NOT NULL DEFAULT 0 COMMENT 'Project owner user ID',
        name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Project name',
        description VARCHAR(256) NOT NULL DEFAULT '' COMMENT 'Project description',
        color VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'Project color identifier (e.g., #FF5733)',
        sort_order INT NOT NULL DEFAULT 0 COMMENT 'Sort order for display',
        is_expanded TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is expanded in UI',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is active (soft delete)',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
        PRIMARY KEY (id),
        KEY idx_projects_user_id (user_id),
        KEY idx_projects_sort_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Projects table for task organization'
    """
    )

    # Check if project_id column already exists to make migration idempotent
    columns = [col["name"] for col in inspector.get_columns("tasks")]
    if "project_id" not in columns:
        # Add project_id column to tasks table
        op.execute(
            """
            ALTER TABLE tasks
            ADD COLUMN project_id INT NOT NULL DEFAULT 0 COMMENT 'Project ID for task grouping'
            """
        )

        # Add index on project_id
        op.execute(
            """
            CREATE INDEX idx_tasks_project_id ON tasks(project_id)
            """
        )
    else:
        # Column already exists, check if index exists
        indexes = [idx["name"] for idx in inspector.get_indexes("tasks")]
        if "idx_tasks_project_id" not in indexes:
            # Index is missing, create it
            op.execute(
                """
                CREATE INDEX idx_tasks_project_id ON tasks(project_id)
                """
            )


def downgrade() -> None:
    """Drop project_id from tasks table and drop projects table."""
    # Drop index on project_id
    op.execute("DROP INDEX idx_tasks_project_id ON tasks")

    # Drop project_id column from tasks table
    op.execute("ALTER TABLE tasks DROP COLUMN project_id")

    # Drop projects table
    op.execute("DROP TABLE IF EXISTS projects")
