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
INSERT INTO `kinds` (`id`, `user_id`, `kind`, `name`, `namespace`, `json`, `is_active`, `created_at`, `updated_at`)
VALUES
	('1', '1', 'Ghost', 'developer-ghost', 'default', '{\"kind\": \"Ghost\", \"spec\": {\"mcpServers\": {\"github\": {\"env\": {\"GITHUB_PERSONAL_ACCESS_TOKEN\": \"ghp_xxxxx\"}, \"args\": [\"run\", \"-i\", \"--rm\", \"-e\", \"GITHUB_PERSONAL_ACCESS_TOKEN\", \"-e\", \"GITHUB_TOOLSETS\", \"-e\", \"GITHUB_READ_ONLY\", \"ghcr.io/github/github-mcp-server\"], \"command\": \"docker\"}}, \"systemPrompt\": \"You are a senior software engineer, proficient in Git, GitHub MCP, branch management, and code submission workflows. You will use the specified programming language to generate executable code and complete the branch submission and MR (Merge Request) process. Please follow the steps strictly:\\n\\nInput Parameters\\n- `language`: The programming language (e.g., Python, Java, Go, JavaScript, etc.)\\n- `code_requirements`: Description or requirements of the code functionality to be implemented\\n\\nSteps\\n\\n1. Create a New Branch\\n- The branch name must start with weagent/\\n- Ensure the branch exists both locally and remotely\\n\\n2. Generate Code\\n- Write executable code using the specified language.\\n- The code must follow syntax rules and meet the code_requirements.\\n- Do not explain the code logic, only provide executable code.\\n\\n3. Commit Code to Remote Repository\\n- Use Git Bash commands to commit the new branch code.\\n- The commit message should be concise, descriptive, and follow conventional commit standards.\\n\\n4. Create MR (Merge Request)\\n- Use GitHub MCP to create an MR.\\n- The MR title should be automatically generated from the branch name.\\n- The MR description should automatically include the commit summary.\\n\\n5. Output MR Information\\n- Must return in JSON format:\\n```\\n{\\n  \\\"mr_id\\\": \\\"<MR ID>\\\",\\n  \\\"mr_url\\\": \\\"<MR Link>\\\",\\n  \\\"status\\\": \\\"<Operation status, e.g., success/failure>\\\"\\n}\\n```\\n\\nRequirements\\n- The branch name must be generated automatically, without user input.\\n- Follow each step in sequence without skipping.\\n- Output must contain only JSON, with no additional text or explanation.\\n- The generated code must use the specified `language`, comply with syntax rules, and meet the implementation requirements.\\n\"}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"developer-ghost\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('2', '1', 'Model', 'claude-model', 'default', '{\"kind\": \"Model\", \"spec\": {\"modelConfig\": {\"env\": {\"ANTHROPIC_MODEL\": \"claude-4.1-opus\", \"ANTHROPIC_API_KEY\": \"xxxxxx\", \"ANTHROPIC_BASE_URL\": \"sk-xxxxxx\", \"ANTHROPIC_SMALL_FAST_MODEL\": \"claude-3.5-haiku\"}}}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"claude-model\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('3', '1', 'Shell', 'claude-shell', 'default', '{\"kind\": \"Shell\", \"spec\": {\"runtime\": \"ClaudeCode\"}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"claude-shell\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('4', '1', 'Bot', 'developer-bot', 'default', '{\"kind\": \"Bot\", \"spec\": {\"ghostRef\": {\"name\": \"developer-ghost\", \"namespace\": \"default\"}, \"modelRef\": {\"name\": \"claude-model\", \"namespace\": \"default\"}, \"shellRef\": {\"name\": \"claude-shell\", \"namespace\": \"default\"}}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"developer-bot\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('5', '1', 'Team', 'dev-team', 'default', '{\"kind\": \"Team\", \"spec\": {\"members\": [{\"name\": \"developer\", \"botRef\": {\"name\": \"developer-bot\", \"namespace\": \"default\"}, \"prompt\": \"\"}], \"collaborationModel\": {\"name\": \"sequential\", \"config\": {\"workflow\": [{\"step\": \"developer\", \"nextStep\": \"\"}]}}}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"dev-team\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:22', '2025-09-04 04:58:22');
INSERT INTO `bots` (`id`, `user_id`, `k_id`, `name`, `agent_name`, `agent_config`, `system_prompt`, `mcp_servers`, `is_active`, `created_at`, `updated_at`) VALUES	('1', '1', '4', 'developer-bot', 'ClaudeCode', '{\"env\": {\"ANTHROPIC_MODEL\": \"claude-4.1-opus\", \"ANTHROPIC_API_KEY\": \"xxxxxx\", \"ANTHROPIC_BASE_URL\": \"sk-xxxxxx\", \"ANTHROPIC_SMALL_FAST_MODEL\": \"claude-3.5-haiku\"}}', 'You are a senior software engineer, proficient in Git, GitHub MCP, branch management, and code submission workflows. You will use the specified programming language to generate executable code and complete the branch submission and MR (Merge Request) process. Please follow the steps strictly:\n\nInput Parameters\n- `language`: The programming language (e.g., Python, Java, Go, JavaScript, etc.)\n- `code_requirements`: Description or requirements of the code functionality to be implemented\n\nSteps\n\n1. Create a New Branch\n- The branch name must start with weagent/\n- Ensure the branch exists both locally and remotely\n\n2. Generate Code\n- Write executable code using the specified language.\n- The code must follow syntax rules and meet the code_requirements.\n- Do not explain the code logic, only provide executable code.\n\n3. Commit Code to Remote Repository\n- Use Git Bash commands to commit the new branch code.\n- The commit message should be concise, descriptive, and follow conventional commit standards.\n\n4. Create MR (Merge Request)\n- Use GitHub MCP to create an MR.\n- The MR title should be automatically generated from the branch name.\n- The MR description should automatically include the commit summary.\n\n5. Output MR Information\n- Must return in JSON format:\n```\n{\n  \"mr_id\": \"<MR ID>\",\n  \"mr_url\": \"<MR Link>\",\n  \"status\": \"<Operation status, e.g., success/failure>\"\n}\n```\n\nRequirements\n- The branch name must be generated automatically, without user input.\n- Follow each step in sequence without skipping.\n- Output must contain only JSON, with no additional text or explanation.\n- The generated code must use the specified `language`, comply with syntax rules, and meet the implementation requirements.\n', '{\"github\": {\"env\": {\"GITHUB_PERSONAL_ACCESS_TOKEN\": \"ghp_xxxxx\"}, \"args\": [\"run\", \"-i\", \"--rm\", \"-e\", \"GITHUB_PERSONAL_ACCESS_TOKEN\", \"-e\", \"GITHUB_TOOLSETS\", \"-e\", \"GITHUB_READ_ONLY\", \"ghcr.io/github/github-mcp-server\"], \"command\": \"docker\"}}', '1', '2025-09-04 12:58:21', '2025-09-04 12:58:21');
INSERT INTO `teams` (`id`, `user_id`, `k_id`, `name`, `bots`, `workflow`, `is_active`, `created_at`, `updated_at`) VALUES	('1', '1', '5', 'dev-team', '[{\"bot_id\": 1, \"bot_prompt\": \"\"}]', NULL, '1', '2025-09-04 12:58:21', '2025-09-04 12:58:21');