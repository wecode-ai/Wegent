-- SPDX-FileCopyrightText: 2025 Weibo, Inc.
--
-- SPDX-License-Identifier: Apache-2.0

-- Create database
CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Use database
USE task_manager;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_name VARCHAR(50) NOT NULL,
    password_hash VARCHAR(256),
    email VARCHAR(100),
    git_info JSON,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `idx_user_name` (`user_name`)
);

-- Create bots table
CREATE TABLE IF NOT EXISTS bots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    k_id INT,
    name VARCHAR(100) NOT NULL,
    agent_name VARCHAR(100) NOT NULL,
    agent_config JSON NOT NULL,
    system_prompt TEXT,
    mcp_servers JSON,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE KEY `idx_k_id` (`k_id`)
);

-- Create teams table
CREATE TABLE IF NOT EXISTS teams (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    k_id INT,
    name VARCHAR(100) NOT NULL,
    bots JSON NOT NULL COMMENT 'JSON array of bot objects, e.g. [{"bot_id":1,"bot_prompt":"xx"}]',
    workflow JSON,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX `idx_user_id` (`user_id`),
    UNIQUE KEY `idx_k_id` (`k_id`)
);

CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    k_id INT,
    user_name VARCHAR(50) NOT NULL,
    title VARCHAR(256) NOT NULL,
    team_id INT NOT NULL,
    git_url VARCHAR(512) NOT NULL,
    git_repo VARCHAR(512) NOT NULL,
    git_repo_id INT NOT NULL,
    git_domain VARCHAR(100) NOT NULL,
    branch_name VARCHAR(100) NOT NULL,
    prompt TEXT NOT NULL,
    status ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETE') NOT NULL DEFAULT 'PENDING',
    progress INT NOT NULL DEFAULT 0,
    batch INT NOT NULL DEFAULT 0,
    result JSON,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (team_id) REFERENCES teams(id),
    INDEX idx_status (status),
    UNIQUE KEY `idx_k_id` (`k_id`)
);

CREATE TABLE IF NOT EXISTS subtasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    task_id INT NOT NULL,
    team_id INT NOT NULL,
    title VARCHAR(256) NOT NULL,
    bot_id INT NOT NULL,
    prompt TEXT,
    executor_namespace VARCHAR(100),
    executor_name VARCHAR(100),
    status ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETE') NOT NULL DEFAULT 'PENDING',
    progress INT NOT NULL DEFAULT 0,
    batch INT NOT NULL DEFAULT 0,
    result JSON,
    error_message TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (team_id) REFERENCES teams(id),
    FOREIGN KEY (bot_id) REFERENCES bots(id),
    INDEX idx_task_sort (task_id, sort_order),
    INDEX idx_status (status)
);

-- Create kinds table to replace all k_* tables
CREATE TABLE IF NOT EXISTS kinds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    kind VARCHAR(50) NOT NULL COMMENT 'Resource type: Ghost, Model, Shell, Bot, Team, Workspace, Task',
    name VARCHAR(100) NOT NULL,
    namespace VARCHAR(100) NOT NULL DEFAULT 'default',
    json JSON NOT NULL COMMENT 'Resource-specific data in JSON format',
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE KEY `idx_user_kind_name_namespace` (`user_id`, `kind`, `name`, `namespace`),
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_kind` (`kind`)
);

-- Initialize user data (admin/admin)
INSERT INTO `users` (`user_name`, `password_hash`, `email`) VALUES ('admin', '$2b$12$G251OMpmvmxn5LcRjFYzOeg6fkavMKu/U3Xzxmu0VhiY.Lk5RqbT.', 'admin@example.com');