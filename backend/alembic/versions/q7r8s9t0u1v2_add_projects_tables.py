# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add projects and project_tasks tables for task organization

Revision ID: q7r8s9t0u1v2
Revises: p6q7r8s9t0u1
Create Date: 2026-01-12 11:30:00.000000+08:00

This migration adds support for project functionality:
1. Creates projects table to store project information
2. Creates project_tasks table for project-task many-to-many relationship
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
    """Create projects and project_tasks tables."""
    # Create projects table
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS projects (
        id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
        user_id INT NOT NULL COMMENT 'Project owner user ID',
        name VARCHAR(100) NOT NULL COMMENT 'Project name',
        description TEXT NOT NULL COMMENT 'Project description',
        color VARCHAR(20) DEFAULT NULL COMMENT 'Project color identifier (e.g., #FF5733)',
        sort_order INT NOT NULL DEFAULT 0 COMMENT 'Sort order for display',
        is_expanded TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is expanded in UI',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is active (soft delete)',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
        PRIMARY KEY (id),
        KEY idx_projects_user_id (user_id),
        KEY idx_projects_sort_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Projects table for task organization'
    """
    )

    # Create project_tasks association table
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


def downgrade() -> None:
    """Drop project_tasks and projects tables."""
    # Drop project_tasks table first (due to foreign key constraints)
    op.execute("DROP TABLE IF EXISTS project_tasks")

    # Drop projects table
    op.execute("DROP TABLE IF EXISTS projects")
