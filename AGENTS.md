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

## 📖 Terminology: Team vs Bot (IMPORTANT - Avoid Confusion!)

**⚠️ CRITICAL: AI coding agents MUST understand the distinction between code-level terms and UI-level terms to avoid confusion when writing code or documentation.**

### Terminology Mapping Table

| Code/CRD Level (English) | Frontend UI (Chinese) | Frontend UI (English) | Description |
|--------------------------|----------------------|----------------------|-------------|
| **Team** | **智能体** | **Agent** | The user-facing AI agent that executes tasks |
| **Bot** | **机器人** | **Bot/Robot** | A building block component that makes up a Team |

### Conceptual Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│  Team (Code) = 智能体 (UI)                                       │
│  ├── What users see and interact with in the frontend           │
│  ├── Contains one or more Bots with collaboration modes         │
│  └── Executes Tasks assigned by users                           │
├─────────────────────────────────────────────────────────────────┤
│  Bot (Code) = 机器人 (UI)                                        │
│  ├── A component/building block of a Team                       │
│  ├── Combines: Ghost (prompt) + Shell (runtime) + Model (LLM)   │
│  └── Users configure Bots, then assemble them into Teams        │
└─────────────────────────────────────────────────────────────────┘
```

### Key Relationship

```
Bot = Ghost (灵魂/提示词) + Shell (运行环境) + Model (AI模型)
Team = Bot(s) + Collaboration Mode (协作模式)
Task = Team + Workspace (代码仓库)
```

**In simple terms:**
- **Bot (机器人)**: The "worker" - a configured AI unit with specific capabilities
- **Team (智能体)**: The "team of workers" - one or more Bots working together to complete user tasks

### Correct Usage Examples

**✅ CORRECT:**
```typescript
// When referring to what users see in the UI
"用户创建了一个新的智能体" // User created a new Team (智能体)
"配置机器人的提示词"      // Configure the Bot's (机器人) prompt

// When writing code/API comments
"Create a new Team resource"     // CRD level - use "Team"
"Bot references Ghost and Shell" // CRD level - use "Bot"
```

**❌ INCORRECT (Common Mistakes):**
```typescript
// DON'T mix up the terms
"用户创建了一个新的团队"   // WRONG - "团队" is not used, should be "智能体"
"创建机器人来执行任务"    // WRONG - Tasks are executed by Teams (智能体), not Bots (机器人) directly

// DON'T confuse code-level and UI-level terms
"The agent contains multiple teams" // WRONG - should be "Team contains multiple Bots"
```

### File/Component Naming Convention

| Domain | Naming Pattern | Example |
|--------|---------------|---------|
| API Routes | Use CRD names | `/api/teams`, `/api/bots` |
| Database/Models | Use CRD names | `Team`, `Bot` |
| Frontend i18n keys | Use CRD names | `teams.title`, `bots.title` |
| Frontend i18n values (zh-CN) | Use UI terms | `"智能体列表"`, `"机器人"` |
| Frontend i18n values (en) | Can use either | `"Agents"` or `"Teams"` |

### Quick Reference for AI Agents

When writing code or documentation, always ask:
1. **Am I writing code/API?** → Use `Team` and `Bot` (CRD names)
2. **Am I writing user-facing Chinese text?** → Use `智能体` and `机器人`
3. **Am I writing user-facing English text?** → Use `Agent`/`Team` and `Bot`

**Remember:**
- `Team` in code = `智能体` in Chinese UI = What users interact with
- `Bot` in code = `机器人` in Chinese UI = Building blocks that make up a Team

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

**Component Reusability Principles:**

⚠️ **CRITICAL: Always check for existing components before creating new ones**

Before implementing any new UI component:

1. **Search existing components**: Check `src/components/ui/`, `src/components/common/`, and `src/features/*/components/`
   ```bash
   # Search for similar components
   find frontend/src/components -name "*.tsx" | grep -i <keyword>
   grep -r "export.*function.*Component" frontend/src/components/
   ```

2. **Extract reusable logic**: If implementing similar UI patterns multiple times, extract as common component
   - Location: `src/components/common/` for shared business components
   - Location: `src/components/ui/` for pure UI components (shadcn/ui)
   - Example: Multiple modals with similar structure → extract `BaseModal` component
   - Example: Repeated form patterns → extract reusable form field components

3. **Component extraction checklist**:
   - [ ] Used in 2+ different features/pages
   - [ ] Self-contained logic (no tight coupling to parent)
   - [ ] Clear props interface with TypeScript types
   - [ ] Flexible enough for different use cases
   - [ ] Follow single responsibility principle

4. **Avoid duplication**:
   - DO NOT copy-paste component code
   - DO NOT create feature-specific versions of generic components
   - DO extract common props and styling to shared components
   - DO use composition over duplication

**Example - Good Practice:**
```tsx
// ❌ BAD: Duplicated modal components in different features
// features/tasks/components/task-modal.tsx
// features/teams/components/team-modal.tsx

// ✅ GOOD: Extract common modal, compose specific content
// components/common/base-modal.tsx
export function BaseModal({ title, children, onClose, ...props }) {
  return <Dialog {...props}>...</Dialog>
}

// features/tasks/components/task-form-modal.tsx
export function TaskFormModal() {
  return <BaseModal title="Create Task"><TaskForm /></BaseModal>
}
```

**Component organization**:
```
frontend/src/components/
├── ui/              # shadcn/ui pure UI components (Button, Input, Dialog, etc.)
├── common/          # Shared business components (EmptyState, LoadingSpinner, etc.)
└── [feature]/       # Feature-specific components (only if not reusable)
```

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
│   │   ├── api/          # Route handlers (auth, bots, models, shells, teams, tasks, chat, git, executors, dify, quota, admin, groups)
│   │   ├── core/         # Config, security, cache, YAML init
│   │   ├── models/       # SQLAlchemy models (Kind, User, Subtask, Namespace, NamespaceMember, SharedTeam, SharedTask, SkillBinary, SubtaskAttachment)
│   │   ├── schemas/      # Pydantic schemas & CRD definitions (namespace.py, namespace_member.py)
│   │   ├── services/     # Business logic (chat/, adapters/, search/, kind.py, repository.py, group_service.py, group_permission.py)
│   │   └── repository/   # Git providers (GitHub, GitLab, Gitee, Gerrit)
│   ├── alembic/          # Database migrations
│   └── init_data/        # YAML initialization data
├── frontend/             # Next.js frontend
│   └── src/
│       ├── app/          # Pages: /, /login, /settings, /chat, /code, /tasks, /shared/task, /admin
│       ├── apis/         # API clients (client.ts + module-specific, admin.ts, groups.ts)
│       ├── components/   # UI components (ui/ for shadcn, common/)
│       ├── features/     # Feature modules (common, layout, login, settings, tasks, theme, onboarding, admin)
│       │   └── settings/components/groups/  # Group management components
│       ├── hooks/        # Custom hooks (useChatStream, useTranslation, useAttachment, useStreamingRecovery)
│       ├── i18n/         # Internationalization (en, zh-CN)
│       └── types/        # TypeScript types (group.ts, api.ts)
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

> **📖 Terminology Note:** See [Terminology: Team vs Bot](#-terminology-team-vs-bot-important---avoid-confusion) section for the distinction between code-level terms (Team, Bot) and UI-level terms (智能体, 机器人).

### Resource Hierarchy

```
Ghost (system prompt + MCP servers + skills)
   ↓
Bot (Ghost + Shell + optional Model)           ← UI: 机器人 (Bot)
   ↓
Team (multiple Bots with roles)                ← UI: 智能体 (Agent) - What users interact with
   ↓
Task (Team + Workspace) → Subtasks (messages/steps)
```

### CRD Definitions (apiVersion: agent.wecode.io/v1)

| Kind | Purpose | UI Name (zh-CN) | Key Spec Fields |
|------|---------|-----------------|-----------------|
| **Ghost** | System prompt & tools | - | `systemPrompt`, `mcpServers`, `skills` |
| **Model** | LLM configuration | 模型 | `modelConfig`, `isCustomConfig`, `protocol` |
| **Shell** | Execution environment | 执行器 | `shellType`, `supportModel`, `baseImage`, `baseShellRef` |
| **Bot** | Agent building block | **机器人** | `ghostRef`, `shellRef`, `modelRef`, `agent_config` |
| **Team** | User-facing agent | **智能体** | `members[{botRef, prompt, role}]`, `collaborationModel` |
| **Task** | Execution unit | 任务 | `title`, `prompt`, `teamRef`, `workspaceRef` |
| **Workspace** | Git repository | 工作空间 | `repository{gitUrl, gitRepo, branchName, gitDomain}` |
| **Skill** | Claude Code skill | 技能 | `description`, `version`, `author`, `tags` |

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
- `WEB_SEARCH_*` - Web search configuration (see `backend/app/services/search/README.md`)
  - `WEB_SEARCH_ENABLED` - Enable/disable web search feature (default: false)
  - `WEB_SEARCH_ENGINES` - JSON string containing adapter configuration

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
- `src/features/settings/` - Models, Teams, Bots, Shells, Skills, Groups management
- `src/features/tasks/` - Chat interface, Workbench, streaming
- `src/apis/` - API client modules

**Route Groups:** `(tasks)` wraps `/chat` and `/code` with shared contexts (UserProvider, TaskContextProvider, ChatStreamProvider)

**State Management:** Context-based (UserContext, TaskContext, ChatStreamContext, ThemeContext)

**API Routes:** `/api/chat/stream` proxies SSE to backend (required for streaming)

**Key features:**
- Streaming chat with recovery (`useStreamingRecovery`)
- PDF export (`ExportPdfButton`, `pdf-generator.ts`)
- Task/Team sharing (`TaskShareModal`, `TeamShareModal`)
- Group management (`GroupManager`, `GroupMembersDialog`)
- Resource scoping (personal, group, all)
- Dify integration (`DifyAppSelector`, `DifyParamsForm`)
- Web search integration (Globe icon toggle in chat interface)

**Key environment variables:**
- `NEXT_PUBLIC_API_URL` - Backend API URL
- `NEXT_PUBLIC_LOGIN_MODE` - Authentication mode ('password', 'oidc', 'all')

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
| **Public** | System-provided models, shared across all users | `kinds` table (user_id=0, namespace='default') |
| **User** | User-defined private models | `kinds` table (user_id=xxx, namespace='default') |
| **Group** | Group-shared models | `kinds` table (user_id=xxx, namespace!=default) |

**Note:**
- Group resources use `user_id=xxx`, `namespace!=default` (user_id represents who created the group resource)
- Public models migrated from `public_models` table to `kinds` table with `user_id=0` marker (kind='Model')
- Public shells also migrated to `kinds` table with `user_id=0` marker (kind='Shell')

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
| `/api/groups` | Group (Namespace) management (CRUD, members, permissions) |
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

### Group API Endpoints (`/api/groups`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | List all groups where user is a member |
| `/` | POST | Create new group |
| `/{group_name:path}` | GET | Get group details |
| `/{group_name:path}` | PUT | Update group info |
| `/{group_name:path}` | DELETE | Delete group |
| `/{group_name:path}/members` | GET | List group members |
| `/{group_name:path}/members` | POST | Add member to group |
| `/{group_name:path}/members/{member_id}` | GET | Get member details |
| `/{group_name:path}/members/{member_id}` | PUT | Update member role |
| `/{group_name:path}/members/{member_id}` | DELETE | Remove member from group |
| `/{group_name:path}/permissions` | GET | Check user permissions in group |

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

## 📦 Group (Namespace) Management

**Groups (Namespaces) provide resource organization and collaboration for Bots, Models, Shells, and Teams.**

### Overview

Groups are organizational units that allow users to:
- **Organize resources**: Group related Bots, Models, Shells, and Teams together
- **Collaborate**: Share resources with team members via group membership
- **Hierarchical structure**: Support nested groups (e.g., `parent/child/grandchild`)

### Group Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Unique identifier, immutable (supports hierarchical format: `aaa/bbb/ccc`) |
| `display_name` | string | Human-readable name (optional, mutable) |
| `owner_user_id` | int | Group creator and owner |
| `visibility` | enum | Access level: `private`, `internal`, `public` (default: `public`, currently not enforced) |
| `description` | string | Group description |
| `is_active` | bool | Group status |
| `member_count` | int | Number of members in the group |
| `resource_count` | int | Number of resources in the group |

### Group Roles & Permissions

| Role | Permissions |
|------|-------------|
| **Owner** | Full control: manage group, members, and all resources |
| **Maintainer** | Manage resources, add/remove members (except Owner) |
| **Developer** | Create and edit resources, view members |
| **Reporter** | Read-only access to resources |

### Hierarchical Groups

Groups support up to 5 levels of nesting using `/` separator:
- Format: `parent/child/grandchild`
- Example: `ai-team/models/production`
- Permissions: Inherited from parent groups
- Max depth: 5 levels (0-4 slashes)

### Resource Scopes

When querying resources (Bots, Models, Shells, Teams), you can specify a scope:

| Scope | Description | API Parameter |
|-------|-------------|---------------|
| `personal` | Only user's own resources | `scope=personal` |
| `group` | Resources from a specific group | `scope=group&group_name=<name>` |
| `all` | All accessible resources (personal + shared + public) | `scope=all` (default) |

### Frontend Components

**Location:** `frontend/src/features/settings/components/groups/`

| Component | Purpose |
|-----------|---------|
| `GroupManager` | Main group list and management interface |
| `CreateGroupDialog` | Create new group dialog |
| `EditGroupDialog` | Edit group details |
| `DeleteGroupConfirmDialog` | Confirm group deletion |
| `GroupMembersDialog` | Manage group members and roles |
| `GroupSelector` | Dropdown selector for resource creation |
| `BotListWithScope`, `ModelListWithScope`, `ShellListWithScope`, `TeamListWithScope` | Resource lists with group filtering |


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
