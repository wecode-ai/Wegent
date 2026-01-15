# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Simplify project-task relationship by adding project_id to tasks table

Revision ID: r8s9t0u1v2w3
Revises: q7r8s9t0u1v2
Create Date: 2026-01-15 10:00:00.000000+08:00

This migration simplifies the project-task relationship:
1. Adds project_id column to tasks table
2. Migrates data from project_tasks table to tasks.project_id
3. Drops the project_tasks table (no longer needed)

The relationship changes from many-to-many to one-to-many:
- Before: A task could belong to multiple projects (via project_tasks table)
- After: A task can belong to at most one project (via project_id column)
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "r8s9t0u1v2w3"
down_revision: Union[str, None] = "q7r8s9t0u1v2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add project_id to tasks table, migrate data, and drop project_tasks table."""
    # Step 1: Add project_id column to tasks table
    op.execute(
        """
        ALTER TABLE tasks
        ADD COLUMN project_id INT DEFAULT NULL COMMENT 'Project ID for task grouping'
        """
    )

    # Step 2: Add index on project_id
    op.execute(
        """
        CREATE INDEX idx_tasks_project_id ON tasks(project_id)
        """
    )

    # Step 3: Add foreign key constraint
    op.execute(
        """
        ALTER TABLE tasks
        ADD CONSTRAINT fk_tasks_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        """
    )

    # Step 4: Migrate data from project_tasks to tasks.project_id
    # For tasks that were in multiple projects, keep only the most recently added association
    op.execute(
        """
        UPDATE tasks t
        INNER JOIN (
            SELECT task_id, project_id
            FROM project_tasks pt1
            WHERE added_at = (
                SELECT MAX(added_at)
                FROM project_tasks pt2
                WHERE pt2.task_id = pt1.task_id
            )
        ) latest_pt ON t.id = latest_pt.task_id
        SET t.project_id = latest_pt.project_id
        """
    )

    # Step 5: Drop project_tasks table (no longer needed)
    op.execute("DROP TABLE IF EXISTS project_tasks")


def downgrade() -> None:
    """Recreate project_tasks table and migrate data back from tasks.project_id."""
    # Step 1: Recreate project_tasks table
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS project_tasks (
            id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
            project_id INT NOT NULL COMMENT 'Project ID',
            task_id INT NOT NULL COMMENT 'Task ID',
            sort_order INT NOT NULL DEFAULT 0 COMMENT 'Sort order within the project',
            added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the task was added to the project',
            PRIMARY KEY (id),
            UNIQUE KEY uniq_project_task (project_id, task_id),
            KEY idx_project_tasks_project_id (project_id),
            KEY idx_project_tasks_task_id (task_id),
            CONSTRAINT fk_project_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            CONSTRAINT fk_project_tasks_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Project-Task association table'
        """
    )

    # Step 2: Migrate data from tasks.project_id to project_tasks
    op.execute(
        """
        INSERT INTO project_tasks (project_id, task_id, sort_order, added_at)
        SELECT project_id, id, 0, NOW()
        FROM tasks
        WHERE project_id IS NOT NULL
        """
    )

    # Step 3: Drop foreign key constraint from tasks
    op.execute(
        """
        ALTER TABLE tasks DROP FOREIGN KEY fk_tasks_project
        """
    )

    # Step 4: Drop index on project_id
    op.execute(
        """
        DROP INDEX idx_tasks_project_id ON tasks
        """
    )

    # Step 5: Drop project_id column from tasks table
    op.execute(
        """
        ALTER TABLE tasks DROP COLUMN project_id
        """
    )
