# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Wiki Feature Documentation

## Overview

The Wiki feature enables automatic generation of comprehensive documentation for code repositories. It analyzes code structures, architectures, and APIs to produce wiki-style documentation.

## Architecture

### Database Design

Wiki tables are stored in the main database (`task_manager`) alongside other application tables:

- **wiki_projects**: Stores project metadata (repository info, source type, etc.)
- **wiki_generations**: Tracks document generation tasks and their status
- **wiki_contents**: Stores generated wiki content sections

### Key Components

1. **WikiService** (`app/services/wiki_service.py`): Core business logic
2. **WikiConfig** (`app/core/wiki_config.py`): Configuration management
3. **WikiPrompts** (`app/core/wiki_prompts.py`): Task prompt templates
4. **Wiki API** (`app/api/endpoints/wiki.py`): REST API endpoints

## Configuration

All wiki-related configuration uses the `WIKI_` prefix in environment variables:

```bash
# Wiki tables are stored in the main database (task_manager)
# No separate database configuration needed

# Feature toggle
WIKI_ENABLED=True

# Task execution settings
WIKI_DEFAULT_TEAM_ID=1           # Default team for task execution
WIKI_DEFAULT_AGENT_TYPE=ClaudeCode  # Agent type to use
WIKI_DEFAULT_USER_ID=1           # User ID for task creation (0 = use current user)

# Generation limits
WIKI_MAX_CONCURRENT_GENERATIONS=5
WIKI_RESULT_POLL_INTERVAL_SECONDS=30
WIKI_RESULT_POLL_BATCH_SIZE=20

# Content settings
WIKI_MAX_CONTENT_SIZE=10485760   # 10MB max
WIKI_SUPPORTED_FORMATS=["markdown", "html"]
WIKI_CONTENT_WRITE_BASE_URL=http://backend:8000
WIKI_CONTENT_WRITE_ENDPOINT=/api/internal/wiki/generations/contents
WIKI_DEFAULT_SECTION_TYPES=["overview", "architecture", "module", "api", "guide", "deep"]
WIKI_INTERNAL_API_TOKEN=weki
```

## API Endpoints

### Public Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/wiki/projects` | List all wiki projects |
| GET | `/api/wiki/projects/{id}` | Get project details |
| POST | `/api/wiki/generations` | Create new wiki generation |
| GET | `/api/wiki/generations` | List generations for a project |
| GET | `/api/wiki/generations/{id}` | Get generation details |
| GET | `/api/wiki/generations/{id}/contents` | Get generation contents |
| POST | `/api/wiki/generations/{id}/cancel` | Cancel running generation |

### Internal Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/internal/wiki/generations/contents` | Write generation contents (agent use) |

## Database Setup

Wiki tables are stored in the main database (`task_manager`).

### Option 1: Automatic Migration (Development)

In development mode with `DB_AUTO_MIGRATE=True`, tables are created automatically on startup.

### Option 2: Manual SQL (Production)

Use the provided SQL script to create wiki tables in the main database:

```bash
mysql -u user -p task_manager < backend/wiki_tables.sql
```

## Generation Workflow

1. **Create Generation**: User creates a new wiki generation request
2. **Task Creation**: System creates a code task with wiki generation prompt
3. **Agent Execution**: ClaudeCode agent analyzes code and generates documentation
4. **Content Writing**: Agent writes content sections via internal API
5. **Completion**: Generation status updated to COMPLETED

## Status Flow

```
PENDING -> RUNNING -> COMPLETED
                   -> FAILED
                   -> CANCELLED
```

## Content Structure

Generated wiki content is organized into sections:

- **overview**: Project overview and key features
- **architecture**: System architecture and design patterns
- **module**: Module-level documentation
- **api**: API reference documentation
- **guide**: Usage guides and tutorials
- **deep**: Deep-dive technical analysis

## Troubleshooting

### Common Issues

1. **Database Connection Failed**
   - Verify `DATABASE_URL` is correct (wiki uses main database)
   - Ensure task_manager database exists and is accessible

2. **Task Creation Failed**
   - Check `WIKI_DEFAULT_TEAM_ID` points to valid team
   - Verify `WIKI_DEFAULT_USER_ID` user exists (or set to 0)

3. **Repository Access Denied (403)**
   - When using `WIKI_DEFAULT_USER_ID`, the configured user must have access to the GitLab/GitHub repository
   - Error message: "Wiki task user 'username' does not have access to repository"
   - Solutions:
     - Add the wiki task user to the GitLab project with at least Reporter access level
     - Or add the wiki task user to the GitHub repository with at least Read access level
     - Or set `WIKI_DEFAULT_USER_ID=0` to use the current user's credentials instead
   - Note: This check applies to both GitLab and GitHub repositories when `WIKI_DEFAULT_USER_ID` is different from the current user


4. **Content Write Failed**
   - Verify `WIKI_CONTENT_WRITE_BASE_URL` is accessible
   - Check `WIKI_INTERNAL_API_TOKEN` matches

### Logs

Wiki operations are logged with `[wiki]` prefix for easy filtering:

```bash
grep "\[wiki\]" app.log
```
