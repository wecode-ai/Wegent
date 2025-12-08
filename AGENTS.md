# AGENTS.md

Wegent is an open-source AI-native operating system for defining, organizing, and running intelligent agent teams. This guide provides instructions for AI coding agents working on this multi-module project.

---

## 🔄 Maintaining This File

**When to update AGENTS.md:**
- Adding new modules, commands, or workflows
- Changing code style guidelines or testing requirements
- Updating dependencies, tech stack, or architecture patterns
- Adding new UI components or design patterns

**How to update:**
1. Edit this file directly with clear, concise instructions
2. Use imperative voice for commands (e.g., "Run tests" not "You should run tests")
3. Keep examples minimal but complete
4. Remove outdated information immediately
5. Test all commands before documenting them

---

## 📝 Documentation Update Requirements

**⚠️ CRITICAL: Update documentation after every significant code change**

AI agents MUST update relevant documentation immediately after completing code changes. This ensures the codebase remains self-documenting and other agents can work efficiently.

### When to Update Documentation

| Change Type | Required Documentation Updates |
|-------------|-------------------------------|
| New API endpoint | Update `Key API Endpoints` section, add to `docs/` if complex |
| New CRD/Schema | Update `CRD Architecture` section |
| New Agent type | Update `Executor` section and agent types table |
| New UI component | Update `Component Library` section if reusable |
| New module/directory | Update `Project Structure` section |
| New environment variable | Update relevant `Module-Specific Guidance` section |
| Breaking change | Add migration notes, update version |
| New feature | Update relevant section, add to changelog if exists |

### Documentation Files to Consider

| File | When to Update |
|------|----------------|
| `AGENTS.md` / `CLAUDE.md` | Architecture, workflows, module guidance changes |
| `docs/en/guides/developer/` | Developer-facing guides, setup, testing |
| `README.md` | Project overview, quick start, major features |
| `backend/app/schemas/` | API schema changes (self-documenting) |
| `frontend/src/types/` | TypeScript types (self-documenting) |

### Documentation Checklist (Post-Implementation)

Before creating a PR, verify:
- [ ] AGENTS.md updated if architecture/workflow changed
- [ ] API docs accurate (check `/api/docs` endpoint)
- [ ] New environment variables documented
- [ ] Breaking changes noted
- [ ] Version number updated in `docker-compose.yml` and AGENTS.md if releasing

### Auto-Reminder System

The pre-push git hook will remind you to update documentation when:
- Files in `backend/app/api/` are modified
- Files in `backend/app/schemas/` are modified
- New directories are created

If the reminder appears and documentation is already up-to-date, use:
```bash
AI_VERIFIED=1 git push
```

---

## 📋 Project Overview

**Multi-module architecture:**
- **Backend** (FastAPI + SQLAlchemy + MySQL): RESTful API and business logic
- **Frontend** (Next.js 15 + TypeScript + React 19): Web UI with shadcn/ui components
- **Executor**: Task execution engine (Claude Code, Agno, Dify, ImageValidator)
- **Executor Manager**: Task orchestration via Docker
- **Shared**: Common utilities, models, and cryptography
- **Wegent CLI** (`wegent-cli/`): kubectl-style CLI for resource management

**Core principles:**
- Kubernetes-inspired CRD design (Ghost, Model, Shell, Bot, Team, Task, Skill, Workspace)
- High cohesion, low coupling - extract common logic, avoid duplication
- Choose simplest working solution - prioritize code simplicity and extensibility

---

## 🚀 Quick Start

```bash
# Clone and start all services
git clone https://github.com/wecode-ai/wegent.git
cd wegent
docker-compose up -d

# Access points
# Frontend: http://localhost:3000
# Backend API: http://localhost:8000/api/docs
# Executor Manager: http://localhost:8001
```

### Module Development

**Backend:**
```bash
cd backend
./start.sh
# Or manually with uv:
# uv sync && source .venv/bin/activate
# uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Frontend:**
```bash
cd frontend
npm install && npm run dev
```

**Executor / Executor Manager:**
```bash
cd executor  # or executor_manager
./start.sh
# Or manually: uv sync && source .venv/bin/activate
# python main.py (executor) | uvicorn main:app --port 8001 (manager)
```

---

## 🧪 Testing

**Always run tests before committing.** Target coverage: 40-60% minimum, 70-80% preferred.

```bash
# Backend
cd backend && pytest --cov=app

# Frontend
cd frontend && npm test

# E2E tests (Playwright)
cd frontend && npm run test:e2e

# Executor / Executor Manager / Shared
cd <module> && pytest tests/ --cov
```

**Test principles:**
- Follow AAA pattern: Arrange, Act, Assert
- Mock external services (Anthropic, OpenAI, Docker, APIs)
- Use descriptive test names explaining what's tested
- Test edge cases and error conditions
- Keep tests independent and isolated

---

## 💻 Code Style

**⚠️ All code comments MUST be written in English.** This includes inline comments, block comments, docstrings, TODO/FIXME annotations, and type hints descriptions.

### Python (Backend, Executor, Executor Manager, Shared)

**Standards:** PEP 8, Black formatter (line length: 88), isort, type hints required

```bash
black . && isort .
pylint app/ && flake8 app/
```

**Guidelines:**
- Descriptive names, docstrings for public functions/classes
- Extract magic numbers to constants
- Max 50 lines per function (preferred)

### TypeScript/React (Frontend)

**Standards:** TypeScript strict mode, functional components, Prettier, ESLint, single quotes, no semicolons

```bash
npm run format && npm run lint
```

**Guidelines:**
- Use `const` over `let`, never `var`
- Component names: PascalCase, files: kebab-case
- Types in `src/types/`

---

## 🎨 Frontend Design System

### Color System - Calm UI Philosophy

**Design principles:** Low saturation + low contrast, minimal shadows, generous whitespace, mint blue (`#14B8A6`) as primary accent.

**Core CSS variables:**
```css
/* Backgrounds: --color-bg-base, --color-bg-surface, --color-bg-muted, --color-bg-hover */
/* Text: --color-text-primary, --color-text-secondary, --color-text-muted */
/* Borders: --color-border, --color-border-strong */
/* Theme: --color-primary (#14B8A6), --color-error, --color-link */
```

**Tailwind usage:**
```jsx
className="bg-base text-text-primary"        // Page background
className="bg-surface border-border"         // Card
className="bg-primary text-white"            // Primary button
```

### Spacing & Typography

- Spacing: `p-2` (8px), `p-4` (16px), `p-6` (24px), `gap-3` (12px)
- Border radius: `rounded-2xl` (16px), `rounded-lg` (12px), `rounded-md` (6px)
- Typography: H1 `text-xl font-semibold`, H2 `text-lg font-semibold`, Body `text-sm`

### Component Library (shadcn/ui)

**Location:** `frontend/src/components/ui/`

**Core components:** Button (variants: default/secondary/ghost/outline/link), Card, Input, Dialog, Drawer, Select, SearchableSelect, Switch, Checkbox, RadioGroup, Badge, Tag, Alert, Toast, Tooltip, Form (react-hook-form + zod), Transfer, Progress, Spinner

**Example:**
```jsx
import { Button } from '@/components/ui/button'
<Button variant="default">Save</Button>
<Button variant="ghost" size="icon"><PencilIcon className="w-4 h-4" /></Button>
```

---

## 🔄 Git Workflow

### Git Hooks (Husky)

**Location:** `frontend/.husky/`

Git hooks are managed by [Husky](https://typicode.github.io/husky/) and configured in the frontend module. The hooks are automatically installed when running `npm install` in the frontend directory (via the `prepare` script).

**Available hooks:**

| Hook | Purpose |
|------|---------|
| `pre-commit` | Python formatting (black + isort) for staged `.py` files, lint-staged for frontend files |
| `commit-msg` | Validates commit message format (Conventional Commits) |
| `pre-push` | Runs AI push gate quality checks (`scripts/hooks/ai-push-gate.sh`) |

**Setup:**
```bash
cd frontend
npm install  # Automatically runs 'husky frontend/.husky' via prepare script
```

### AI Code Quality Check (Pre-push)

**⚠️ CRITICAL: AI Agents MUST Comply with Git Hook Output**

1. **If quality checks fail**: FIX all reported issues, DO NOT use `--no-verify`
2. **If documentation reminders appear**: Update docs first, or use `AI_VERIFIED=1 git push` after thorough verification

```bash
# Normal workflow
git add . && git commit -m "feat: your feature" && git push

# If doc reminders shown after verification
AI_VERIFIED=1 git push

# Manual check
bash scripts/hooks/ai-push-gate.sh
```

### Pre-commit Hook Details

The pre-commit hook performs:
1. **Python formatting**: Automatically formats staged `.py` files with `black` and `isort`, then re-stages them
2. **Frontend linting**: Runs `lint-staged` for frontend files (prettier + eslint)

### Branch Naming & Commits

**Branch pattern:** `<type>/<description>` (feature/, fix/, refactor/, docs/, test/, chore/)

**Commit format:** [Conventional Commits](https://www.conventionalcommits.org/)
```
<type>[scope]: <description>
# Types: feat | fix | docs | style | refactor | test | chore
# Example: feat(backend): add Ghost YAML import API
```

---

## 🏗️ Project Structure

```
wegent/
├── backend/              # FastAPI backend
│   ├── app/
│   │   ├── api/          # Route handlers (auth, bots, models, shells, teams, tasks, chat, git, executors, dify, quota, admin)
│   │   ├── core/         # Config, security, cache, YAML init
│   │   ├── models/       # SQLAlchemy models (Kind, User, Subtask, PublicModel, PublicShell, SharedTeam, SharedTask, SkillBinary, SubtaskAttachment)
│   │   ├── schemas/      # Pydantic schemas & CRD definitions
│   │   ├── services/     # Business logic (chat/, adapters/, kind.py, repository.py)
│   │   └── repository/   # Git providers (GitHub, GitLab, Gitee, Gerrit)
│   ├── alembic/          # Database migrations
│   └── init_data/        # YAML initialization data
├── frontend/             # Next.js frontend
│   └── src/
│       ├── app/          # Pages: /, /login, /settings, /chat, /code, /tasks, /shared/task, /admin
│       ├── apis/         # API clients (client.ts + module-specific, admin.ts)
│       ├── components/   # UI components (ui/ for shadcn, common/)
│       ├── features/     # Feature modules (common, layout, login, settings, tasks, theme, onboarding, admin)
│       ├── hooks/        # Custom hooks (useChatStream, useTranslation, useAttachment, useStreamingRecovery)
│       ├── i18n/         # Internationalization (en, zh-CN)
│       └── types/        # TypeScript types
├── executor/             # Task executor (runs in Docker)
│   ├── agents/           # ClaudeCode, Agno, Dify, ImageValidator
│   ├── callback/         # Progress callback handlers
│   ├── services/         # AgentService
│   └── tasks/            # TaskProcessor, TaskStateManager, ResourceManager
├── executor_manager/     # Task orchestration
│   ├── executors/        # DockerExecutor, dispatcher
│   ├── scheduler/        # APScheduler-based task scheduling
│   ├── clients/          # TaskAPIClient
│   └── routers/          # API routes
├── shared/               # Common utilities
│   ├── models/           # Task data models
│   ├── utils/            # crypto, git_util, http_util, yaml_util
│   └── status.py         # TaskStatus enum
├── wegent-cli/           # CLI tool (wectl)
├── docker/               # Dockerfiles for all modules
├── docs/                 # Documentation (en/, zh/)
└── scripts/hooks/        # Git hook scripts (called by Husky)
```

**Note:** Git hooks are managed by Husky in `frontend/.husky/`, not in a root `.githooks/` directory.

---

## 🔧 CRD Architecture (Kubernetes-inspired)

### Resource Hierarchy

```
Ghost (system prompt + MCP servers + skills)
   ↓
Bot (Ghost + Shell + optional Model)
   ↓
Team (multiple Bots with roles)
   ↓
Task (Team + Workspace) → Subtasks (messages/steps)
```

### CRD Definitions (apiVersion: agent.wecode.io/v1)

| Kind | Purpose | Key Spec Fields |
|------|---------|-----------------|
| **Ghost** | System prompt & tools | `systemPrompt`, `mcpServers`, `skills` |
| **Model** | LLM configuration | `modelConfig`, `isCustomConfig`, `protocol` |
| **Shell** | Execution environment | `shellType`, `supportModel`, `baseImage`, `baseShellRef` |
| **Bot** | Agent unit | `ghostRef`, `shellRef`, `modelRef`, `agent_config` |
| **Team** | Agent group | `members[{botRef, prompt, role}]`, `collaborationModel` |
| **Task** | Execution unit | `title`, `prompt`, `teamRef`, `workspaceRef` |
| **Workspace** | Git repository | `repository{gitUrl, gitRepo, branchName, gitDomain}` |
| **Skill** | Claude Code skill | `description`, `version`, `author`, `tags` |

### Shell Types

| Type | Label | Description |
|------|-------|-------------|
| `ClaudeCode` | `local_engine` | Claude Code SDK in Docker |
| `Agno` | `local_engine` | Agno framework in Docker |
| `Dify` | `external_api` | External Dify API proxy |
| `Chat` | `direct_chat` | Direct LLM API (no Docker) |

---

## 🔧 Module-Specific Guidance

### Backend

**Tech:** FastAPI, SQLAlchemy, Pydantic, MySQL, Redis, Alembic

**Key directories:**
- `app/api/` - Route handlers
- `app/services/adapters/` - CRD service implementations
- `app/services/chat/` - Streaming chat with model resolver
- `app/services/attachment/` - File attachment storage with pluggable backends
- `app/repository/` - Git providers (GitHub, GitLab, Gitee, Gerrit)

**Common tasks:**
- Add endpoint: Create in `app/api/`, schema in `app/schemas/`, logic in `app/services/`
- Add model: Create in `app/models/`, run `alembic revision --autogenerate -m "description"`

**Key environment variables:**
- `DATABASE_URL`, `REDIS_URL`, `SECRET_KEY`, `ALGORITHM`
- `OIDC_*` - OpenID Connect configuration
- `WEBHOOK_*` - Webhook notification settings
- `ATTACHMENT_STORAGE_BACKEND` - Storage backend for file attachments (default: "mysql")
  - Supported values: "mysql", "s3", "minio"
  - When set to "mysql", binary data is stored in the database
  - When set to "s3" or "minio", files are stored in external object storage
- `ATTACHMENT_S3_*` - S3/MinIO configuration (required when using S3/MinIO backend)
  - `ATTACHMENT_S3_ENDPOINT` - S3 endpoint URL (e.g., "https://s3.amazonaws.com" or "http://minio:9000")
  - `ATTACHMENT_S3_ACCESS_KEY` - S3 access key
  - `ATTACHMENT_S3_SECRET_KEY` - S3 secret key
  - `ATTACHMENT_S3_BUCKET` - S3 bucket name (default: "attachments")
  - `ATTACHMENT_S3_REGION` - S3 region (default: "us-east-1")
  - `ATTACHMENT_S3_USE_SSL` - Use SSL for S3 connections (default: true)

#### Database Migrations (Alembic)

```bash
cd backend
alembic revision --autogenerate -m "description"  # Create migration
alembic upgrade head                               # Apply migrations
alembic current                                    # Check status
alembic downgrade -1                               # Rollback one
```

**Development:** Auto-migrate when `ENVIRONMENT=development` and `DB_AUTO_MIGRATE=True`

#### Resolving Alembic Multiple Heads

When multiple developers create migrations simultaneously, Alembic may have multiple heads after merging branches.

**Detection:**
- Pre-commit and pre-push hooks automatically detect multiple heads
- Manual check: `./scripts/check-alembic.sh`

**Resolution:**
```bash
# Step 1: Check current heads
cd backend && alembic heads

# Step 2: Merge heads
alembic merge -m "merge heads" <head1> <head2>

# Step 3: Apply migration
alembic upgrade head

# Step 4: Commit the merge migration
git add backend/alembic/versions/
git commit -m "chore: merge alembic heads"
```

**Auto-fix:** Run `./scripts/check-alembic.sh --fix` to automatically merge multiple heads.

**Prevention:**
- Always pull latest `main` before creating new migration
- Use standard revision ID format (auto-generated by `alembic revision --autogenerate`)
- Run `./scripts/check-alembic.sh` before committing
- Coordinate with team when multiple migration PRs are open

### Frontend

**Tech:** Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui, i18next

**Key directories:**
- `src/app/` - App Router pages
- `src/features/settings/` - Models, Teams, Bots, Shells, Skills management
- `src/features/tasks/` - Chat interface, Workbench, streaming
- `src/apis/` - API client modules

**Route Groups:** `(tasks)` wraps `/chat` and `/code` with shared contexts (UserProvider, TaskContextProvider, ChatStreamProvider)

**State Management:** Context-based (UserContext, TaskContext, ChatStreamContext, ThemeContext)

**API Routes:** `/api/chat/stream` proxies SSE to backend (required for streaming)

**Key features:**
- Streaming chat with recovery (`useStreamingRecovery`)
- PDF export (`ExportPdfButton`, `pdf-generator.ts`)
- Task/Team sharing (`TaskShareModal`, `TeamShareModal`)
- Dify integration (`DifyAppSelector`, `DifyParamsForm`)

### Executor

**Tech:** Python, Claude Code SDK, Agno, Dify API, MCP

**Agent types:**
| Agent | Type | Key Features |
|-------|------|--------------|
| `ClaudeCode` | `local_engine` | Claude Code SDK, Git clone, Skills support, MCP servers, custom instructions (.cursorrules, .windsurfrules) |
| `Agno` | `local_engine` | Team modes (coordinate/collaborate/route), SQLite sessions, MCP support |
| `Dify` | `external_api` | Proxy to Dify (chat/chatflow/workflow/agent-chat modes), no local code execution |
| `ImageValidator` | `validator` | Custom base image validation |

**Key files:**
- `agents/factory.py` - Agent factory
- `agents/base.py` - Base Agent class
- `tasks/task_state_manager.py` - Task state tracking
- `callback/callback_client.py` - Progress callbacks

**Environment variables:**
- `ANTHROPIC_AUTH_TOKEN` (Claude Code), `ANTHROPIC_API_KEY` (Agno)
- `DIFY_API_KEY`, `DIFY_BASE_URL`
- `CALLBACK_URL`, `WORKSPACE_ROOT`

### Executor Manager

**Tech:** Python, Docker SDK, FastAPI, APScheduler

**Key components:**
- `scheduler/scheduler.py` - Periodic task fetching (online/offline)
- `executors/docker/executor.py` - Docker container lifecycle
- `clients/task_api_client.py` - Backend API communication

**Environment variables:**
- `TASK_API_DOMAIN`, `EXECUTOR_IMAGE`, `NETWORK`
- `MAX_CONCURRENT_TASKS` (default: 30)
- `PORT_RANGE_MIN/MAX` (10000-10100)

---

## 🔧 Model Management

### Model Types

| Type | Description | Storage |
|------|-------------|---------|
| **Public** | System-provided, shared across users | `public_models` table |
| **User** | User-defined private models | `kinds` table (kind='Model') |

### Model Resolution Order

1. Task-level model override (`force_override_bot_model`)
2. Bot's `bind_model` from `agent_config`
3. Bot's `modelRef` (legacy)
4. Default model

### Key APIs

```
GET  /api/models/unified              # List all models (public + user)
GET  /api/models/unified/{name}       # Get model by name
POST /api/models/test-connection      # Test API connection
GET  /api/models/compatible?agent_name=X  # Get compatible models
```

### Bot Model Binding

```yaml
# Recommended: bind_model in agent_config
spec:
  agent_config:
    bind_model: "my-model"
    bind_model_type: "user"  # 'public' or 'user'

# Legacy: modelRef
spec:
  modelRef:
    name: model-name
    namespace: default
```

---

## 📡 Key API Endpoints

### Backend Routes

| Prefix | Purpose |
|--------|---------|
| `/api/auth` | Authentication (login, OIDC) |
| `/api/users` | User management |
| `/api/bots` | Bot CRUD |
| `/api/models` | Model management (unified, test-connection, compatible) |
| `/api/shells` | Shell management (unified, validate-image) |
| `/api/teams` | Team CRUD, sharing |
| `/api/tasks` | Task CRUD, cancel, sharing |
| `/api/chat` | Streaming chat, cancel, resume-stream |
| `/api/subtasks` | Subtask management |
| `/api/attachments` | File upload/download |
| `/api/git` | Repository, branches, diff |
| `/api/executors` | Task dispatch, status updates |
| `/api/dify` | Dify app info, parameters |
| `/api/v1/namespaces/{ns}/{kinds}` | Kubernetes-style Kind API |
| `/api/v1/kinds/skills` | Skill upload/management |
| `/api/admin` | Admin operations (user management, public models, system stats) |

### Admin API Endpoints (`/api/admin`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/users` | GET | List all users with pagination |
| `/users` | POST | Create new user |
| `/users/{user_id}` | GET | Get user details |
| `/users/{user_id}` | PUT | Update user info |
| `/users/{user_id}` | DELETE | Soft delete user (deactivate) |
| `/users/{user_id}/reset-password` | POST | Reset user password |
| `/users/{user_id}/toggle-status` | POST | Toggle user active status |
| `/users/{user_id}/role` | PUT | Update user role |
| `/public-models` | GET | List public models |
| `/public-models` | POST | Create public model |
| `/public-models/{model_id}` | GET | Get public model details |
| `/public-models/{model_id}` | PUT | Update public model |
| `/public-models/{model_id}` | DELETE | Delete public model |
| `/stats` | GET | Get system statistics |

### Executor Manager Routes

| Endpoint | Purpose |
|----------|---------|
| `/executor-manager/callback` | Task progress callbacks |
| `/executor-manager/tasks/receive` | Batch task submission |
| `/executor-manager/tasks/cancel` | Cancel running task |
| `/executor-manager/images/validate` | Validate base image |

---

## 👥 User Role System

### Role Types

| Role | Description | Permissions |
|------|-------------|-------------|
| `admin` | System administrator | Full access to admin panel, user management, public model management |
| `user` | Regular user | Standard access to tasks, teams, bots, models, shells |

### Role-Based Access Control

- **Admin Panel** (`/admin`): Only accessible to users with `role='admin'`
- **User Menu**: Admin users see additional "Admin" menu item
- **API Protection**: Admin endpoints require `get_admin_user` dependency

### User Model Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | int | Primary key |
| `user_name` | string | Unique username |
| `email` | string | Optional email |
| `role` | enum | 'admin' or 'user' (default: 'user') |
| `auth_source` | enum | 'password', 'oidc', or 'unknown' |
| `is_active` | bool | Account status |
| `created_at` | datetime | Creation timestamp |
| `updated_at` | datetime | Last update timestamp |

### Database Migration

The `role` column was added via migration `b2c3d4e5f6a7_add_role_to_users.py`:
- Default value: 'user'
- Users with `user_name='admin'` are automatically set to `role='admin'`

---

## 🔒 Security

- Never commit credentials - use `.env` files
- Frontend: Only use `NEXT_PUBLIC_*` for client-safe values
- Backend encrypts Git tokens and API keys (AES-256-CBC)
- Change default passwords in production
- OIDC support for enterprise SSO
- Role-based access control for admin operations

---

## 🐛 Debugging

```bash
# Service logs
docker logs -f wegent-backend
docker logs -f <executor-container-id>

# Database access
docker exec -it wegent-mysql mysql -u root -p123456 task_manager

# Redis access
docker exec -it wegent-redis redis-cli
```

**Common issues:**
- Database connection failed: Check MySQL running, verify credentials
- Streaming not working: Ensure `/api/chat/stream` proxy route exists in frontend
- Task stuck in PENDING: Check executor_manager logs, verify `TASK_API_DOMAIN`

---

## 📖 Resources

- **API Docs**: http://localhost:8000/api/docs
- **Testing Guide**: `docs/en/guides/developer/testing.md`
- **Setup Guide**: `docs/en/guides/developer/setup.md`
- **Migration Guide**: `docs/en/guides/developer/database-migrations.md`

---

## 🎯 Quick Reference

```bash
# Start/stop services
docker-compose up -d
docker-compose down

# View logs
docker-compose logs -f [service]

# Run tests
cd backend && pytest
cd frontend && npm test

# Format code
cd backend && black . && isort .
cd frontend && npm run format

# Database migration
cd backend && alembic revision --autogenerate -m "msg" && alembic upgrade head
```

**Ports:** 3000 (frontend), 8000 (backend), 8001 (executor manager), 3306 (MySQL), 6379 (Redis), 10000-10100 (executors)

---

**Last Updated**: 2025-12
**Wegent Version**: 1.0.20
**Maintained by**: WeCode-AI Team
