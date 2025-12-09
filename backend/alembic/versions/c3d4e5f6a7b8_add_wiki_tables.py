# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add wiki tables for wiki feature

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2025-12-03 10:00:00.000000+08:00

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add wiki_projects, wiki_generations, and wiki_contents tables."""

    # Create wiki_projects table
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS wiki_projects (
        id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key auto increment ID',
        project_name VARCHAR(200) NOT NULL DEFAULT '' COMMENT 'Project name',
        project_type VARCHAR(50) NOT NULL DEFAULT 'git' COMMENT 'Project type: git, local, etc',
        source_type VARCHAR(50) NOT NULL DEFAULT 'github' COMMENT 'Source type: github, gitlab, gitee, etc',
        source_url VARCHAR(500) NOT NULL DEFAULT '' COMMENT 'Source repository URL',
        source_id VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Source repository ID',
        source_domain VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Source domain name',
        description TEXT DEFAULT NULL COMMENT 'Project description',
        ext JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Project extension data',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is active: 1=active, 0=inactive',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Record update time',

        UNIQUE KEY uniq_source_url (source_url),
        INDEX idx_project_name (project_name),
        INDEX idx_project_type (project_type),
        INDEX idx_source_type (source_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    )

    # Create wiki_generations table
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS wiki_generations (
        id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key auto increment ID',
        project_id INT NOT NULL DEFAULT 0 COMMENT 'Associated project ID',
        user_id INT NOT NULL DEFAULT 0 COMMENT 'User ID who created the generation',
        task_id INT DEFAULT NULL COMMENT 'Associated task ID',
        team_id INT NOT NULL DEFAULT 0 COMMENT 'Team ID for task execution',
        generation_type VARCHAR(20) NOT NULL DEFAULT 'full' COMMENT 'Generation type: full, incremental, custom',
        source_snapshot JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Source snapshot information including branch, commit, etc',
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'Generation status: PENDING, RUNNING, COMPLETED, FAILED, CANCELLED',
        ext JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Extension fields for additional metadata',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Record update time',
        completed_at DATETIME DEFAULT NULL COMMENT 'Generation completion time',

        INDEX idx_project_id (project_id),
        INDEX idx_user_id (user_id),
        INDEX idx_task_id (task_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at),
        INDEX idx_user_project (user_id, project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    )

    # Create wiki_contents table
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS wiki_contents (
        id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key auto increment ID',
        generation_id INT NOT NULL DEFAULT 0 COMMENT 'Associated generation ID',
        type VARCHAR(50) NOT NULL DEFAULT 'chapter' COMMENT 'Content type: chapter, section, overview, etc',
        title VARCHAR(500) NOT NULL DEFAULT '' COMMENT 'Content title',
        content LONGTEXT DEFAULT NULL COMMENT 'Content body in markdown format',
        parent_id INT NOT NULL DEFAULT 0 COMMENT 'Parent content ID for hierarchical structure',
        ext JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'Content extension data',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Record update time',

        INDEX idx_generation_id (generation_id),
        INDEX idx_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    )


def downgrade() -> None:
    """Remove wiki tables only if they are empty.

    This migration is designed to be safe - it will not drop tables
    that contain data to prevent accidental data loss.
    """
    # Only drop tables if they are empty (no data)
    # If tables have data, skip dropping to preserve existing data

    # Check and drop wiki_contents if empty
    op.execute(
        """
    SET @table_empty = (SELECT COUNT(*) = 0 FROM wiki_contents);
    SET @drop_query = IF(@table_empty, 'DROP TABLE IF EXISTS wiki_contents', 'SELECT 1');
    PREPARE stmt FROM @drop_query;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
    """
    )

    # Check and drop wiki_generations if empty
    op.execute(
        """
    SET @table_empty = (SELECT COUNT(*) = 0 FROM wiki_generations);
    SET @drop_query = IF(@table_empty, 'DROP TABLE IF EXISTS wiki_generations', 'SELECT 1');
    PREPARE stmt FROM @drop_query;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
    """
    )

    # Check and drop wiki_projects if empty
    op.execute(
        """
    SET @table_empty = (SELECT COUNT(*) = 0 FROM wiki_projects);
    SET @drop_query = IF(@table_empty, 'DROP TABLE IF EXISTS wiki_projects', 'SELECT 1');
    PREPARE stmt FROM @drop_query;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
    """
    )
