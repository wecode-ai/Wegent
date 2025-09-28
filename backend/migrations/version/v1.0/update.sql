-- SPDX-FileCopyrightText: 2025 Weibo, Inc.
--
-- SPDX-License-Identifier: Apache-2.0

-- Drop foreign key constraints
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_2; -- task_id foreign key
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_3; -- team_id foreign key
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_4; -- bot_id foreign key

-- 删除外键约束
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_2; -- task_id外键
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_3; -- team_id外键
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_4; -- bot_id外键

-- Drop indexes
ALTER TABLE subtasks DROP INDEX idx_task_sort;

-- Drop sort_order column
ALTER TABLE subtasks DROP COLUMN sort_order;

-- Change bot_id column to bot_ids and modify type
ALTER TABLE subtasks 
CHANGE COLUMN bot_id bot_ids JSON NOT NULL COMMENT 'JSON array of bot IDs, e.g. [1,2,3]';

-- Add role column
ALTER TABLE subtasks 
ADD COLUMN role ENUM('USER', 'ASSISTANT') NOT NULL DEFAULT 'ASSISTANT' AFTER bot_ids;

-- Add message_id column
ALTER TABLE subtasks 
ADD COLUMN message_id INT NOT NULL DEFAULT 1 AFTER error_message;

-- Add parent_id column
ALTER TABLE subtasks 
ADD COLUMN parent_id INT DEFAULT NULL AFTER message_id;

-- Add executor_deleted_at column
ALTER TABLE subtasks ADD COLUMN executor_deleted_at DATETIME NULL AFTER executor_name;

-- Create models table
CREATE TABLE IF NOT EXISTS models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    config JSON NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `idx_model_name` (`name`)
);

-- Create agents table
CREATE TABLE IF NOT EXISTS agents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    config JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `idx_agent_name` (`name`)
);