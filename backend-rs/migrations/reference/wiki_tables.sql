-- SPDX-FileCopyrightText: 2025 Weibo, Inc.
--
-- SPDX-License-Identifier: Apache-2.0

-- Wiki Feature Database Schema
-- This script creates the necessary tables for the wiki feature.
-- Wiki tables are now stored in the main database (task_manager).
--
-- Usage:
--   mysql -u user -p task_manager < wiki_tables.sql

-- Wiki Projects Table
-- Stores project metadata for wiki generation
CREATE TABLE IF NOT EXISTS wiki_projects (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key auto increment ID',
    project_name VARCHAR(200) NOT NULL DEFAULT '' COMMENT 'Project name',
    project_type VARCHAR(50) NOT NULL DEFAULT 'git' COMMENT 'Project type: git, local, etc',
    source_type VARCHAR(50) NOT NULL DEFAULT 'github' COMMENT 'Source type: github, gitlab, gitee, etc',
    source_url VARCHAR(500) NOT NULL DEFAULT '' COMMENT 'Source repository URL',
    source_id VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Source repository ID',
    source_domain VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Source domain name',
    description TEXT NOT NULL COMMENT 'Project description',
    ext JSON NOT NULL COMMENT 'Project extension data',
    is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is active: 1=active, 0=inactive',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Record update time',

    UNIQUE KEY uniq_source_url (source_url),
    INDEX idx_project_name (project_name),
    INDEX idx_project_type (project_type),
    INDEX idx_source_type (source_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Wiki Generations Table
-- Tracks document generation tasks and their status
CREATE TABLE IF NOT EXISTS wiki_generations (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key auto increment ID',
    project_id INT NOT NULL DEFAULT 0 COMMENT 'Associated project ID',
    user_id INT NOT NULL DEFAULT 0 COMMENT 'User ID who created the generation',
    task_id INT NOT NULL DEFAULT 0 COMMENT 'Associated task ID',
    team_id INT NOT NULL DEFAULT 0 COMMENT 'Team ID for task execution',
    generation_type VARCHAR(20) NOT NULL DEFAULT 'full' COMMENT 'Generation type: full, incremental, custom',
    source_snapshot JSON NOT NULL COMMENT 'Source snapshot information including branch, commit, etc',
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'Generation status: PENDING, RUNNING, COMPLETED, FAILED, CANCELLED',
    ext JSON NOT NULL COMMENT 'Extension fields for additional metadata',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Record update time',
    completed_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Generation completion time',

    INDEX idx_project_id (project_id),
    INDEX idx_user_id (user_id),
    INDEX idx_task_id (task_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_user_project (user_id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Wiki Contents Table
-- Stores generated wiki content sections
CREATE TABLE IF NOT EXISTS wiki_contents (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key auto increment ID',
    generation_id INT NOT NULL DEFAULT 0 COMMENT 'Associated generation ID',
    type VARCHAR(50) NOT NULL DEFAULT 'chapter' COMMENT 'Content type: chapter, section, overview, etc',
    title VARCHAR(500) NOT NULL DEFAULT '' COMMENT 'Content title',
    content LONGTEXT NOT NULL COMMENT 'Content body in markdown format',
    parent_id INT NOT NULL DEFAULT 0 COMMENT 'Parent content ID for hierarchical structure',
    ext JSON NOT NULL COMMENT 'Content extension data',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Record update time',

    INDEX idx_generation_id (generation_id),
    INDEX idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
