-- SPDX-FileCopyrightText: 2025 Weibo, Inc.
--
-- SPDX-License-Identifier: Apache-2.0

-- Create database
CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Use database
USE task_manager;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key',
    user_name VARCHAR(50) NOT NULL DEFAULT '' COMMENT 'Login username',
    password_hash VARCHAR(256) NOT NULL DEFAULT '' COMMENT 'Credential hash',
    email VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Email address',
    git_info JSON NOT NULL COMMENT 'User Git information',
    is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Active flag',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
    UNIQUE KEY `uniq_user_name` (`user_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS subtasks (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key',
    user_id INT NOT NULL DEFAULT 0 COMMENT 'User ID',
    task_id INT NOT NULL DEFAULT 0 COMMENT 'Task ID',
    team_id INT NOT NULL DEFAULT 0 COMMENT 'Team ID',
    title VARCHAR(256) NOT NULL DEFAULT '' COMMENT 'Subtask title',
    bot_ids JSON NOT NULL COMMENT 'Array of bot IDs, e.g. [1,2,3]',
    role VARCHAR(20) NOT NULL DEFAULT 'ASSISTANT' COMMENT 'Role:USER、ASSISTANT',
    prompt TEXT NOT NULL COMMENT 'Prompt/description',
    executor_namespace VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Executor namespace',
    executor_name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Executor name',
    executor_deleted_at BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Executor deletion flag',
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'Status:PENDING、RUNNING、COMPLETED、FAILED、CANCELLED、DELETE',
    progress INT NOT NULL DEFAULT 0 COMMENT 'Progress percentage',
    result JSON NOT NULL COMMENT 'Execution result (JSON)',
    error_message TEXT NOT NULL COMMENT 'Error message',
    message_id INT NOT NULL DEFAULT 1 COMMENT 'Message ID',
    parent_id INT NOT NULL DEFAULT 0 COMMENT 'Parent subtask ID',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
    completed_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Completion time',
    INDEX idx_user_id (user_id),
    INDEX idx_task_id (task_id),
    INDEX idx_team_id (team_id),
    INDEX idx_created_at (created_at),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Create kinds table to replace all k_* tables
CREATE TABLE IF NOT EXISTS kinds (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key',
    user_id INT NOT NULL DEFAULT 0 COMMENT 'User ID, references users.id',
    kind VARCHAR(50) NOT NULL DEFAULT '' COMMENT 'Resource type: Ghost/Model/Shell/Bot/Team/Workspace/Task',
    name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Resource name',
    namespace VARCHAR(100) NOT NULL DEFAULT 'default' COMMENT 'Namespace',
    json JSON NOT NULL COMMENT 'Resource-specific data (JSON)',
    is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Active flag',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
    UNIQUE KEY `uniq_user_kind_name_namespace` (`user_id`, `kind`, `name`, `namespace`),
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_kind` (`kind`),
    INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Create public_models table
CREATE TABLE IF NOT EXISTS public_models (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key',
    name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Public model name',
    namespace VARCHAR(100) NOT NULL DEFAULT 'default' COMMENT 'Namespace',
    json JSON NOT NULL COMMENT 'Resource-specific data (JSON)',
    is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Active flag',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
    UNIQUE KEY `uniq_public_model_name_namespace` (`name`, `namespace`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Create public_shells table
CREATE TABLE IF NOT EXISTS public_shells (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key',
    name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Public shell name',
    namespace VARCHAR(100) NOT NULL DEFAULT 'default' COMMENT 'Namespace',
    json JSON NOT NULL COMMENT 'Resource-specific data (JSON)',
    is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Active flag',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
    UNIQUE KEY `uniq_public_shell_name_namespace` (`name`, `namespace`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Create shared_teams table for team sharing functionality
CREATE TABLE IF NOT EXISTS shared_teams (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key',
    user_id INT NOT NULL DEFAULT 0 COMMENT 'User ID who joined the shared team',
    original_user_id INT NOT NULL DEFAULT 0 COMMENT 'Original user ID who created the team',
    team_id INT NOT NULL DEFAULT 0 COMMENT 'Team ID that was shared',
    is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Active flag',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
    UNIQUE KEY `uniq_user_team` (`user_id`, `team_id`),
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_original_user_id` (`original_user_id`),
    INDEX `idx_team_id` (`team_id`),
    INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Initialize user data (admin/Wegent2025!)
INSERT INTO `users` (`user_name`, `password_hash`, `email`, `git_info`) VALUES ('admin', '$2b$12$5jQMrJGO8NMXmF90f/xnKeLtM/Deh912k4GRPx.q3nTGOg1e1IJzW', 'admin@example.com', '[]');
INSERT INTO `kinds` (`id`, `user_id`, `kind`, `name`, `namespace`, `json`, `is_active`, `created_at`, `updated_at`)
VALUES
	('1', '1', 'Ghost', 'developer-ghost', 'default', '{\"kind\": \"Ghost\", \"spec\": {\"mcpServers\": {\"github\": {\"env\": {\"GITHUB_PERSONAL_ACCESS_TOKEN\": \"ghp_xxxxx\"}, \"args\": [\"run\", \"-i\", \"--rm\", \"-e\", \"GITHUB_PERSONAL_ACCESS_TOKEN\", \"-e\", \"GITHUB_TOOLSETS\", \"-e\", \"GITHUB_READ_ONLY\", \"ghcr.io/github/github-mcp-server\"], \"command\": \"docker\"}}, \"systemPrompt\": \"You are a senior software engineer, proficient in Git, GitHub MCP, branch management, and code submission workflows. You will use the specified programming language to generate executable code and complete the branch submission and MR (Merge Request) process. Please follow the steps strictly:\\n\\nInput Parameters\\n- `language`: The programming language (e.g., Python, Java, Go, JavaScript, etc.)\\n- `code_requirements`: Description or requirements of the code functionality to be implemented\\n\\nSteps\\n\\n1. Create a New Branch\\n- The branch name must start with wegent/\\n- Ensure the branch exists both locally and remotely\\n\\n2. Generate Code\\n- Write executable code using the specified language.\\n- The code must follow syntax rules and meet the code_requirements.\\n- Do not explain the code logic, only provide executable code.\\n\\n3. Commit Code to Remote Repository\\n- Use Git Bash commands to commit the new branch code.\\n- The commit message should be concise, descriptive, and follow conventional commit standards.\\n\\n4. Create MR (Merge Request)\\n- Use GitHub MCP to create an MR.\\n- The MR title should be automatically generated from the branch name.\\n- The MR description should automatically include the commit summary.\\n\\n5. Output MR Information\\n- Must return in JSON format:\\n```\\n{\\n  \\\"mr_id\\\": \\\"<MR ID>\\\",\\n  \\\"mr_url\\\": \\\"<MR Link>\\\",\\n  \\\"status\\\": \\\"<Operation status, e.g., success/failure>\\\"\\n}\\n```\\n\\nRequirements\\n- The branch name must be generated automatically, without user input.\\n- Follow each step in sequence without skipping.\\n- Output must contain only JSON, with no additional text or explanation.\\n- The generated code must use the specified `language`, comply with syntax rules, and meet the implementation requirements.\\n\"}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"developer-ghost\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('2', '1', 'Model', 'claude-model', 'default', '{\"kind\": \"Model\", \"spec\": {\"modelConfig\": {\"env\": {\"ANTHROPIC_MODEL\": \"claude-4.1-opus\", \"ANTHROPIC_API_KEY\": \"xxxxxx\", \"ANTHROPIC_BASE_URL\": \"sk-xxxxxx\", \"ANTHROPIC_DEFAULT_HAIKU_MODEL\": \"claude-haiku-4-5-20251001\"}}}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"claude-model\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('3', '1', 'Shell', 'claude-shell', 'default', '{\"kind\": \"Shell\", \"spec\": {\"runtime\": \"ClaudeCode\"}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"claude-shell\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('4', '1', 'Bot', 'developer-bot', 'default', '{\"kind\": \"Bot\", \"spec\": {\"ghostRef\": {\"name\": \"developer-ghost\", \"namespace\": \"default\"}, \"modelRef\": {\"name\": \"claude-model\", \"namespace\": \"default\"}, \"shellRef\": {\"name\": \"claude-shell\", \"namespace\": \"default\"}}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"developer-bot\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:21', '2025-09-04 04:58:21'),
	('5', '1', 'Team', 'dev-team', 'default', '{\"kind\": \"Team\", \"spec\": {\"members\": [{\"role\": \"leader\", \"botRef\": {\"name\": \"developer-bot\", \"namespace\": \"default\"}, \"prompt\": \"\"}], \"collaborationModel\": \"pipeline\"}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"dev-team\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:22', '2025-09-04 04:58:22'),
	('6', '1', 'Ghost', 'pm-battle-ghost', 'default', '{"kind": "Ghost","spec": {"mcpServers": {},"systemPrompt": "You are an experienced Product Manager specializing in requirement clarification. Your goal is to help users refine vague requirements into clear, actionable development tasks through structured questioning.\n\n## Your Process\n\n1. **Initial Analysis**: When receiving a user\'s requirement, analyze it for ambiguities and missing details\n2. **Generate Clarification Questions**: Create 3-5 targeted questions in Markdown format following this structure:\n\n```markdown\n## 🤔 需求澄清问题 (Clarification Questions)\n\n### Q1: Does this feature need to support mobile devices?\n**Type**: single_choice\n**Options**:\n- [✓] `yes` - Yes (recommended)\n- [ ] `no` - No\n\n### Q2: What authentication methods should be supported?\n**Type**: multiple_choice\n**Options**:\n- [✓] `email` - Email/Password (recommended)\n- [ ] `oauth` - OAuth (Google, GitHub, etc.)\n- [ ] `phone` - Phone Number + SMS\n\n### Q3: Any additional requirements?\n**Type**: text_input\n```\n\n3. **Process Answers**: When receiving user\'s markdown-formatted answers, analyze them and either:\n   - Ask more questions if needed (repeat step 2)\n   - Generate the final prompt if sufficient clarity is achieved\n\n4. **Generate Final Prompt**: Output the refined requirement in this format:\n\n```markdown\n## ✅ 最终需求提示词 (Final Requirement Prompt)\n\nClear, detailed requirement description that can be directly used for development...\n```\n\n## Question Format Rules\n\n### Question Header\n- Use `### Q{number}: {question_text}` format\n- Question numbers start from 1 and increment sequentially\n\n### Question Types\nSpecify the type using `**Type**: {type}` on the line after the question header.\n\nThree supported types:\n- **single_choice**: Radio buttons, user selects ONE option\n- **multiple_choice**: Checkboxes, user can select MULTIPLE options\n- **text_input**: Free text input (no options needed)\n\n### Options Format (for choice questions)\nUse `**Options**:` followed by a list of options.\n\nEach option follows this format:\n```\n- [✓] `value` - Label text (recommended)\n- [ ] `value` - Label text\n```\n\n- `[✓]` indicates a recommended/default option\n- `[ ]` indicates a regular option\n- Backticks `` `value` `` wrap the technical value\n- Everything after ` - ` is the human-readable label\n\n### Examples\n\n**Single Choice:**\n```markdown\n### Q1: Do you need \"Remember Me\" functionality?\n**Type**: single_choice\n**Options**:\n- [✓] `yes` - Yes (recommended)\n- [ ] `no` - No\n```\n\n**Multiple Choice:**\n```markdown\n### Q2: Which platforms should be supported?\n**Type**: multiple_choice\n**Options**:\n- [✓] `web` - Web Browser (recommended)\n- [ ] `ios` - iOS App\n- [ ] `android` - Android App\n- [ ] `desktop` - Desktop Application\n```\n\n**Text Input:**\n```markdown\n### Q3: Please describe any special requirements\n**Type**: text_input\n```\n\n## Answer Format (User Will Submit)\n\nUsers will submit their answers in this Markdown format:\n\n```markdown\n## 📝 我的回答 (My Answers)\n\n### Q1: Does this feature need to support mobile devices?\n**Answer**: `yes` - Yes\n\n### Q2: What authentication methods should be supported?\n**Answer**:\n- `email` - Email/Password\n- `oauth` - OAuth (Google, GitHub, etc.)\n\n### Q3: Any additional requirements?\n**Answer**: The login page should have a dark mode option.\n```\n\nWhen you receive this format, parse it and analyze the answers.\n\n## Question Design Principles\n\n- Ask 3-5 questions per round (don\'t overwhelm users)\n- Use `[✓]` to mark recommended default options\n- Focus on: target users, core features, technical constraints, success criteria\n- Avoid overly technical jargon\n- Keep question text concise and clear\n\n## Important Rules\n\n- ONLY output valid Markdown (either clarification questions or final prompt)\n- Use the exact heading formats specified above: `## 🤔 需求澄清问题` or `## ✅ 最终需求提示词`\n- Do NOT include additional explanatory text outside the markdown structure\n- The final prompt should be comprehensive and actionable\n- Always include the emoji icons in headings for visual recognition\n\n## Example Flow\n\n**User Input:**\n\"I want to add a login feature\"\n\n**Your Output:**\n```markdown\n## 🤔 需求澄清问题 (Clarification Questions)\n\n### Q1: What authentication methods should be supported?\n**Type**: multiple_choice\n**Options**:\n- [✓] `email` - Email/Password (recommended)\n- [ ] `oauth` - OAuth (Google, GitHub, etc.)\n- [ ] `phone` - Phone Number + SMS\n\n### Q2: Do you need \"Remember Me\" functionality?\n**Type**: single_choice\n**Options**:\n- [✓] `yes` - Yes (recommended)\n- [ ] `no` - No\n\n### Q3: What should happen after failed login attempts?\n**Type**: single_choice\n**Options**:\n- [✓] `lock` - Lock account temporarily (recommended)\n- [ ] `captcha` - Show CAPTCHA verification\n- [ ] `nothing` - No special action\n```\n\n**User Answers:**\n```markdown\n## 📝 我的回答 (My Answers)\n\n### Q1: What authentication methods should be supported?\n**Answer**:\n- `email` - Email/Password\n- `oauth` - OAuth (Google, GitHub, etc.)\n\n### Q2: Do you need \"Remember Me\" functionality?\n**Answer**: `yes` - Yes\n\n### Q3: What should happen after failed login attempts?\n**Answer**: `lock` - Lock account temporarily\n```\n\n**Your Final Output:**\n```markdown\n## ✅ 最终需求提示词 (Final Requirement Prompt)\n\nImplement a user login feature with the following specifications:\n\n**Authentication Methods:**\n- Email/Password authentication (primary method)\n- OAuth integration (support Google and GitHub)\n\n**User Experience:**\n- Include \"Remember Me\" checkbox to keep users logged in\n- After 3 failed login attempts, temporarily lock the account for 15 minutes\n- Display clear error messages for failed attempts\n\n**Security Requirements:**\n- Hash passwords using bcrypt or similar secure algorithm\n- Store OAuth tokens securely\n- Implement rate limiting to prevent brute force attacks\n\n**UI Components:**\n- Login form with email and password fields\n- \"Remember Me\" checkbox\n- \"Forgot Password\" link\n- OAuth login buttons for Google and GitHub\n- Clear validation error messages\n```\n\nNow begin clarifying the user\'s requirements using this Markdown format!\n"},"status": {"state": "Available"},"metadata": {"name": "pm-battle-ghost","namespace": "default"},"apiVersion": "agent.wecode.io/v1"}', '1', '2025-09-04 04:58:22', '2025-09-04 04:58:22'),
	('7', '1', 'Bot', 'pm-battle-bot', 'default', '{\"kind\": \"Bot\", \"spec\": {\"ghostRef\": {\"name\": \"pm-battle-ghost\", \"namespace\": \"default\"}, \"modelRef\": {\"name\": \"claude-model\", \"namespace\": \"default\"}, \"shellRef\": {\"name\": \"claude-shell\", \"namespace\": \"default\"}}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"pm-battle-bot\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:22', '2025-09-04 04:58:22'),
	('8', '1', 'Team', 'pm-battle-team', 'default', '{\"kind\": \"Team\", \"spec\": {\"members\": [{\"role\": \"leader\", \"botRef\": {\"name\": \"pm-battle-bot\", \"namespace\": \"default\"}, \"prompt\": \"\"}], \"collaborationModel\": \"pipeline\"}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"pm-battle-team\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-09-04 04:58:22', '2025-09-04 04:58:22');

INSERT INTO `public_shells` (`id`, `name`, `namespace`, `json`, `is_active`, `created_at`, `updated_at`)
VALUES
	('1', 'ClaudeCode', 'default', '{\"kind\": \"Shell\", \"spec\": {\"runtime\": \"ClaudeCode\", \"supportModel\": []}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"ClaudeCode\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-10-12 11:16:31', '2025-10-12 11:16:31'),
	('2', 'Agno', 'default', '{\"kind\": \"Shell\", \"spec\": {\"runtime\": \"Agno\", \"supportModel\": []}, \"status\": {\"state\": \"Available\"}, \"metadata\": {\"name\": \"Agno\", \"namespace\": \"default\"}, \"apiVersion\": \"agent.wecode.io/v1\"}', '1', '2025-10-12 11:16:54', '2025-10-12 11:16:54');
