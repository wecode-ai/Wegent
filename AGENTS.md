# AGENTS.md

Wegent is an open-source AI-native operating system for defining, organizing, and running intelligent agent teams.

---

## 📋 Project Overview

**Multi-module architecture:**
- **Backend** (FastAPI + SQLAlchemy + MySQL): RESTful API and business logic
- **Frontend** (Next.js 15 + TypeScript + React 19): Web UI with shadcn/ui components
- **Executor**: Task execution engine (Claude Code, Agno, Dify, ImageValidator)
- **Executor Manager**: Task orchestration via Docker
- **Shared**: Common utilities, models, and cryptography

**Core principles:**
- Kubernetes-inspired CRD design (Ghost, Model, Shell, Bot, Team, Task, Skill, Workspace)
- High cohesion, low coupling - extract common logic, avoid duplication
- Choose simplest working solution - prioritize code simplicity and extensibility

**📚 Detailed Documentation:** See `docs/en/` or `docs/zh/` for comprehensive guides on setup, testing, architecture, and user guides.

---

## 📖 Terminology: Team vs Bot

**⚠️ CRITICAL: Understand the distinction between code-level terms and UI-level terms.**

| Code/CRD Level | Frontend UI (Chinese) | Frontend UI (English) | Description |
|----------------|----------------------|----------------------|-------------|
| **Team** | **智能体** | **Agent** | The user-facing AI agent that executes tasks |
| **Bot** | **机器人** | **Bot** | A building block component that makes up a Team |

**Key Relationship:**
```
Bot = Ghost (提示词) + Shell (运行环境) + Model (AI模型)
Team = Bot(s) + Collaboration Mode (协作模式)
Task = Team + Workspace (代码仓库)
```

**Naming Convention:**
- API Routes / Database / Code: Use CRD names (`Team`, `Bot`)
- Frontend i18n values (zh-CN): Use UI terms (`智能体`, `机器人`)
- Frontend i18n values (en): Use `Agent`/`Team` and `Bot`

---

## 🧪 Testing

**Always run tests before committing.** Target coverage: 40-60% minimum.

```bash
cd backend && pytest --cov=app     # Backend
cd frontend && npm test            # Frontend
cd frontend && npm run test:e2e    # E2E tests (Playwright)
```

**Test principles:**
- Follow AAA pattern: Arrange, Act, Assert
- Mock external services (Anthropic, OpenAI, Docker, APIs)
- Test edge cases and error conditions
- Keep tests independent and isolated

**E2E Testing Rules:**
- ⚠️ E2E tests MUST NOT fail gracefully - no `test.skip()`, no silent failures
- ⚠️ NO frontend mocking of backend APIs - send real HTTP requests
- If a test fails, FIX the issue - never skip to make CI pass

---

## 💻 Code Style

**⚠️ All code comments MUST be written in English.**

### General Principles

- **High cohesion, low coupling**: Each module/class should have a single responsibility
- **File size limit**: If a file exceeds **1000 lines**, split it into multiple sub-modules
- **Function length**: Max 50 lines per function (preferred)
- **Avoid duplication**: Extract common logic into shared utilities

### Python (Backend, Executor, Shared)

**Standards:** PEP 8, Black formatter (line length: 88), isort, type hints required

```bash
black . && isort .
```

**Guidelines:**
- Descriptive names, docstrings for public functions/classes
- Extract magic numbers to constants

### TypeScript/React (Frontend)

**Standards:** TypeScript strict mode, functional components, Prettier, ESLint, single quotes, no semicolons

```bash
npm run format && npm run lint
```

**Guidelines:**
- Use `const` over `let`, never `var`
- Component names: PascalCase, files: kebab-case
- Types in `src/types/`

### Component Reusability

⚠️ **Always check for existing components before creating new ones**

1. Search existing components in `src/components/ui/`, `src/components/common/`, `src/features/*/components/`
2. Extract reusable logic if implementing similar UI patterns multiple times
3. Avoid duplication - use composition over copy-paste

**Component Organization:**
```
frontend/src/components/
├── ui/              # shadcn/ui pure UI components
└── common/          # Shared business components

frontend/src/features/
├── layout/          # Layout components
├── tasks/           # Chat/Code task components
├── settings/        # Settings page components
└── [other]/         # Feature-specific components
```

---

## 🎨 Frontend Design System

### Color System - Calm UI Philosophy

**Design principles:** Low saturation + low contrast, minimal shadows, generous whitespace, teal (`#14B8A6`) as primary accent.

**Key CSS Variables:**
```css
--color-bg-base: 255 255 255;          /* Page background */
--color-bg-surface: 247 247 248;       /* Cards, panels */
--color-text-primary: 26 26 26;        /* Primary text */
--color-text-secondary: 102 102 102;   /* Secondary text */
--color-primary: 20 184 166;           /* Teal primary */
--color-border: 224 224 224;           /* Borders */
--radius: 0.5rem;                      /* Border radius (8px) */
```

**Tailwind Usage:**
```jsx
className="bg-base text-text-primary"      // Page background
className="bg-surface border-border"       // Card/Panel
className="bg-primary text-white"          // Primary button
```

### Typography

| Element | Classes |
|---------|---------|
| H1 | `text-xl font-semibold` |
| H2 | `text-lg font-semibold` |
| Body | `text-sm` (14px) |
| Small | `text-xs text-text-muted` |

### Responsive Breakpoints

- Mobile: `max-width: 767px`
- Tablet: `768px - 1023px`
- Desktop: `min-width: 1024px`

```tsx
const isMobile = useIsMobile();   // max-width: 767px
const isDesktop = useIsDesktop(); // min-width: 1024px
```

---

## 🔄 Git Workflow

### Branch Naming & Commits

**Branch pattern:** `<type>/<description>` (feature/, fix/, refactor/, docs/, test/, chore/)

**Commit format:** [Conventional Commits](https://www.conventionalcommits.org/)
```
<type>[scope]: <description>
# Types: feat | fix | docs | style | refactor | test | chore
# Example: feat(backend): add Ghost YAML import API
```

### Git Hooks (Husky)

| Hook | Purpose |
|------|---------|
| `pre-commit` | Python formatting (black + isort), lint-staged for frontend |
| `commit-msg` | Validates commit message format |
| `pre-push` | AI push gate quality checks |

**⚠️ AI Agents MUST comply with Git hook output - FIX issues, DO NOT use `--no-verify`**

---

## 🏗️ Project Structure

```
wegent/
├── backend/              # FastAPI backend
│   ├── app/
│   │   ├── api/          # Route handlers
│   │   ├── core/         # Config, security, cache
│   │   ├── models/       # SQLAlchemy models
│   │   ├── schemas/      # Pydantic schemas & CRD definitions
│   │   └── services/     # Business logic
│   └── alembic/          # Database migrations
├── frontend/             # Next.js frontend
│   └── src/
│       ├── app/          # App Router pages
│       ├── apis/         # API clients
│       ├── components/   # UI components
│       ├── features/     # Feature-specific modules
│       ├── hooks/        # Custom hooks
│       ├── i18n/         # Internationalization
│       └── types/        # TypeScript types
├── executor/             # Task executor (runs in Docker)
├── executor_manager/     # Task orchestration
├── shared/               # Common utilities
└── docker/               # Dockerfiles
```

---

## 🔧 CRD Architecture

### Resource Hierarchy

```
Ghost (system prompt + MCP servers + skills)
   ↓
Bot (Ghost + Shell + optional Model)           ← UI: 机器人
   ↓
Team (multiple Bots with roles)                ← UI: 智能体
   ↓
Task (Team + Workspace) → Subtasks
```

### CRD Definitions (apiVersion: agent.wecode.io/v1)

| Kind | Purpose | Key Spec Fields |
|------|---------|-----------------|
| **Ghost** | System prompt & tools | `systemPrompt`, `mcpServers`, `skills` |
| **Model** | LLM configuration | `modelConfig`, `protocol` |
| **Shell** | Execution environment | `shellType`, `baseImage` |
| **Bot** | Agent building block | `ghostRef`, `shellRef`, `modelRef` |
| **Team** | User-facing agent | `members[]`, `collaborationModel` |
| **Task** | Execution unit | `teamRef`, `workspaceRef` |
| **Workspace** | Git repository | `repository{}` |

### Shell Types

| Type | Description |
|------|-------------|
| `ClaudeCode` | Claude Code SDK in Docker |
| `Agno` | Agno framework in Docker |
| `Dify` | External Dify API proxy |
| `Chat` | Direct LLM API (no Docker) |

---

## 🔧 Module-Specific Guidance

### Backend

**Tech:** FastAPI, SQLAlchemy, Pydantic, MySQL, Redis, Alembic

**Common tasks:**
- Add endpoint: Create in `app/api/`, schema in `app/schemas/`, logic in `app/services/`
- Add model: Create in `app/models/`, run `alembic revision --autogenerate -m "description"`

**Database Migrations:**
```bash
cd backend
alembic revision --autogenerate -m "description"  # Create
alembic upgrade head                               # Apply
alembic downgrade -1                               # Rollback
```

**Web Search Configuration:**
- `WEB_SEARCH_ENABLED`: Enable/disable web search feature (default: `false`)
- `WEB_SEARCH_ENGINES`: JSON config for search engines (see `.env.example` for format)
- `WEB_SEARCH_DEFAULT_MAX_RESULTS`: Default max results when LLM doesn't specify (default: `100`)
  - Can be overridden by per-engine `max_results` in `WEB_SEARCH_ENGINES` config
  - LLM can override by passing `max_results` parameter to the tool

### Frontend

**Tech:** Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui, i18next

**State Management (Context-based):**
- `UserContext` - User auth state
- `TaskContext` - Task list, pagination
- `ChatStreamContext` - WebSocket streaming
- `SocketContext` - Socket.IO connection
- `ThemeContext` - Theme (light/dark)

**i18n Rules:**

1. **Always import from `@/hooks/useTranslation`**, not from `react-i18next`
2. **Use single namespace** matching your feature (e.g., `useTranslation('groups')` for groups feature)
3. **Always add namespace prefix** when accessing keys from other namespaces (e.g., `t('common:actions.save')`)
4. **Never use array with `common` first** - `useTranslation(['common', 'groups'])` will break feature-specific keys
5. **Add new translation keys** to the appropriate namespace file in `src/i18n/locales/{lang}/`

### Executor

**Agent types:**
| Agent | Key Features |
|-------|--------------|
| `ClaudeCode` | Claude Code SDK, Git clone, Skills, MCP servers |
| `Agno` | Team modes, SQLite sessions, MCP support |
| `Dify` | Proxy to Dify API |
| `ImageValidator` | Custom base image validation |

---

## 🔒 Security

- Never commit credentials - use `.env` files
- Frontend: Only use `NEXT_PUBLIC_*` for client-safe values
- Backend encrypts Git tokens and API keys (AES-256-CBC)
- OIDC support for enterprise SSO
- Role-based access control for admin operations

---

## 🎯 Quick Reference

```bash
# Start services
docker-compose up -d

# Run tests
cd backend && pytest
cd frontend && npm test

# Format code
cd backend && black . && isort .
cd frontend && npm run format

# Database migration
cd backend && alembic revision --autogenerate -m "msg" && alembic upgrade head
```

**Ports:** 3000 (frontend), 8000 (backend), 8001 (executor manager), 3306 (MySQL), 6379 (Redis)

---

**Last Updated**: 2025-12
**Wegent Version**: 1.0.20
