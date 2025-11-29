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

## 📋 Project Overview

**Multi-module architecture:**
- **Backend** (FastAPI + SQLAlchemy + MySQL): RESTful API and business logic
- **Frontend** (Next.js 15 + TypeScript + React 19): Web UI with shadcn/ui components
- **Executor**: Task execution engine (Claude Code, Agno, Dify)
- **Executor Manager**: Task orchestration via Docker
- **Shared**: Common utilities and models

**Core principles:**
- Kubernetes-inspired CRD design (Ghost, Model, Shell, Bot, Team, Task)
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
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

**Executor / Executor Manager:**
```bash
cd executor  # or executor_manager
pip install -r requirements.txt
python main.py
```

---

## 🧪 Testing

**Always run tests before committing.** Target coverage: 40-60% minimum, 70-80% preferred.

```bash
# Backend
cd backend && pytest --cov=app

# Frontend
cd frontend && npm test

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

**⚠️ All code comments MUST be written in English.** This includes:
- Inline comments
- Block comments
- Docstrings
- TODO/FIXME annotations
- Type hints descriptions

### Python (Backend, Executor, Executor Manager, Shared)

**Standards:**
- PEP 8 compliant
- Black formatter (line length: 88)
- isort for imports
- Type hints required

```bash
# Format and lint
black . && isort .
pylint app/ && flake8 app/
```

**Guidelines:**
- Descriptive names for functions/variables
- Docstrings for public functions/classes
- Extract magic numbers to constants
- Max 50 lines per function (preferred)

### TypeScript/React (Frontend)

**Standards:**
- TypeScript strict mode
- Functional components with hooks
- Prettier formatter
- ESLint (Next.js config)
- Single quotes, no semicolons

```bash
# Format and lint
npm run format
npm run lint
```

**Guidelines:**
- Use `const` over `let`, never `var`
- Functional patterns preferred
- Component names: PascalCase, files: kebab-case
- Types in `src/types/`

---

## 🎨 Frontend Design System

### Color System - Calm UI Philosophy

**Design principles:**
- Low saturation + low contrast = reduced eye strain
- Minimal shadows, generous whitespace
- Subtle component differentiation (<10% background variance)
- Mint blue (`#14B8A6`) as primary accent - use sparingly

**Core colors (CSS variables):**

```css
/* Backgrounds */
--color-bg-base          /* Main: white (light) / #0E0F0F (dark) */
--color-bg-surface       /* Cards: #F7F7F8 (light) / #1A1C1C (dark) */
--color-bg-muted         /* Subtle: #F2F2F2 (light) / #212424 (dark) */
--color-bg-hover         /* Hover: #E0E0E0 (light) / #2A2D2D (dark) */

/* Text */
--color-text-primary     /* Main text: #1A1A1A (light) / #ECECEC (dark) */
--color-text-secondary   /* Secondary: #666 (light) / #D4D4D4 (dark) */
--color-text-muted       /* Hints: #A0A0A0 (both themes) */

/* Borders */
--color-border           /* Default: #E0E0E0 (light) / #2A2D2D (dark) */
--color-border-strong    /* Emphasis: #C0C0C0 (light) / #343535 (dark) */

/* Theme colors */
--color-primary          /* Mint blue: #14B8A6 */
--color-success          /* Same as primary: #14B8A6 */
--color-error            /* Red: #EF4444 (light) / #F85149 (dark) */
--color-link             /* Blue: #55B9F7 */
--color-code-bg          /* #F6F8FA (light) / #0D1117 (dark) */
```

**Tailwind usage:**
```jsx
className="bg-base text-text-primary"        // Page background
className="bg-surface border-border"         // Card
className="text-text-muted"                  // Subtle text
className="bg-primary text-white"            // Primary button
className="text-link hover:underline"        // Link
```

### Spacing & Sizing

**Standard spacing (1 unit = 4px):**
- `p-2` (8px): Small element padding
- `p-4` (16px): Default card padding
- `p-6` (24px): Large card padding
- `gap-3` (12px): Default element gap
- `space-y-3` (12px): Vertical stacking

**Border radius:**
- `rounded-2xl` (16px): Large containers (ChatArea input, modals)
- `rounded-lg` (12px): Cards, dropdowns
- `rounded-md` (6px): Buttons, inputs, tags
- `rounded-full`: Badges, avatars

**Typography:**
- H1: `text-xl font-semibold` (20px/600) - Page titles
- H2: `text-lg font-semibold` (18px/600) - Section titles
- H3: `text-base font-medium` (16px/500) - Card titles
- Body: `text-sm` (14px/400) - Content, buttons
- Caption: `text-xs text-text-muted` (12px/400) - Hints

### Component Library (shadcn/ui)

**Location:** `frontend/src/components/ui/`

**Core components:**
- **Button**: variants = `default | secondary | ghost | outline | link`
- **Card**: Use for list items, settings panels
- **Input**: Standard text inputs
- **Dialog**: Modals and confirmations
- **Drawer**: Slide-out panels
- **Select**: Dropdowns
- **Switch**: Toggle controls
- **Checkbox / RadioGroup**: Form selections
- **Badge / Tag**: Status indicators
- **Alert**: Page-level notifications
- **Toast**: Temporary notifications (use `useToast()` hook)
- **Dropdown Menu**: Context menus
- **Form**: Built on react-hook-form + zod validation

**Button example:**
```jsx
import { Button } from '@/components/ui/button'

<Button variant="default">Save</Button>
<Button variant="ghost" size="icon"><PencilIcon className="w-4 h-4" /></Button>
<Button className="bg-error hover:bg-error/90">Delete</Button>
```

**Card list layout:**
```jsx
<div className="space-y-3 p-1">
  {items.map(item => (
    <Card key={item.id} className="p-4 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Icon className="w-5 h-5 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-medium truncate">{item.name}</h3>
            <div className="flex gap-1.5 mt-2">
              <Tag variant="default">{item.type}</Tag>
            </div>
          </div>
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <PencilIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  ))}
</div>
```

**Form with validation:**
```jsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Form, FormField, FormItem, FormLabel, FormControl } from '@/components/ui/form'
import { Input } from '@/components/ui/input'

const schema = z.object({
  name: z.string().min(2).max(50),
})

const form = useForm({ resolver: zodResolver(schema) })

<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)}>
    <FormField
      control={form.control}
      name="name"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Name</FormLabel>
          <FormControl>
            <Input {...field} />
          </FormControl>
        </FormItem>
      )}
    />
  </form>
</Form>
```

**Responsive design:**
```jsx
// Mobile-first approach
<div className="px-4 sm:px-6">              // Responsive padding
<div className="grid grid-cols-1 md:grid-cols-2">  // Responsive grid
<p className="hidden sm:block">             // Hide on small screens
```

---

## 🔄 Git Workflow

### AI Code Quality Check (Pre-push)

Wegent uses git hooks to ensure code quality for AI coding agents (Claude Code, Cursor, etc.). All quality checks run **before push**, allowing multiple commits locally without interruption.

**⚠️ CRITICAL: AI Agents MUST Comply with Git Hook Output**

When pushing code, pre-push hooks will run quality checks and may output warnings or errors. **AI coding agents MUST strictly follow the git hook output**:

1. **If quality checks fail** (lint, type check, tests, build):
   - DO NOT use `--no-verify` to bypass
   - FIX all reported issues before pushing again
   - Read the error details in "FAILED CHECKS DETAIL" section

2. **If documentation reminders appear**:
   - STOP and review whether documentation updates are needed
   - If docs need updating: Update relevant documentation files first, then push
   - If docs are already up-to-date: Use `AI_VERIFIED=1 git push` ONLY after thorough verification
   - DO NOT blindly use `AI_VERIFIED=1` to skip - this defeats the purpose of the check

3. **Response to hook output**:
   - Treat hook warnings as mandatory action items
   - Include any required documentation updates in the same commit/push
   - Report hook check results to the user when relevant

**Auto-enabled in Executor:**
When the executor clones a repository, git hooks are automatically configured via `core.hooksPath=.githooks`. No manual installation required.

**Local Development (via npm install):**
```bash
cd frontend && npm install  # Husky automatically configures pre-push hook
```

**Manual Installation (alternative):**
```bash
# Configure git to use .githooks directory
git config core.hooksPath .githooks
```

**Usage:**

```bash
# Normal workflow - checks run automatically before push
git add .
git commit -m "feat: your feature"
git push  # <- Quality checks run here

# If documentation reminders shown, verify and push
AI_VERIFIED=1 git push

# Skip all checks (not recommended)
git push --no-verify
```

**Quality Checks:**

| Check | Tools | Scope |
|-------|-------|-------|
| Doc Reminders | Custom script | API, Schema changes |

**Manual Commands:**
```bash
# Run checks manually
bash scripts/hooks/ai-push-gate.sh

# Skip all checks (not recommended)
git push --no-verify
```

**Check Output Example:**
```
══════════════════════════════════════════════════════════
📋 AI Code Quality Check Report (Pre-push)
══════════════════════════════════════════════════════════

📁 Files to be pushed:
   Total: 6 file(s)
   Modules affected:
   - Backend: 3 file(s)
   - Frontend: 2 file(s)

✅ Lint & Format: PASSED
✅ Type Check: PASSED
✅ Unit Tests: PASSED (backend: 42 passed)
✅ Build Check: PASSED

⚠️ Documentation Reminders:
   - backend/app/api/ changed → Check docs/ for updates

══════════════════════════════════════════════════════════
```

### Branch Naming

**Pattern:** `<type>/<description>`

- `feature/`: New features
- `fix/`: Bug fixes
- `refactor/`: Code refactoring
- `docs/`: Documentation
- `test/`: Tests
- `chore/`: Build/tools

**Example:** `feature/add-ghost-yaml-import`

### Commit Messages

**Format:** [Conventional Commits](https://www.conventionalcommits.org/)

```
<type>[scope]: <description>

[optional body]
```

**Types:** `feat | fix | docs | style | refactor | test | chore`

**Examples:**
```
feat(backend): add Ghost YAML import API
fix(frontend): resolve task status display issue
docs: update AGENTS.md with design system
refactor(executor): simplify agent initialization
```

### Pull Requests

**Title format:** `<type>[scope]: <Title>`

**Before submitting PR:**
- [ ] All tests pass
- [ ] Code formatted and linted
- [ ] No merge conflicts
- [ ] Documentation updated if needed

---

## 🏗️ Project Structure

```
wegent/
├── backend/          # FastAPI backend
│   ├── app/
│   │   ├── api/      # Route handlers
│   │   ├── models/   # SQLAlchemy models
│   │   ├── schemas/  # Pydantic schemas
│   │   └── services/ # Business logic
│   └── init_data/    # YAML initialization data
├── frontend/         # Next.js frontend
│   └── src/
│       ├── app/      # Pages (App Router)
│       ├── apis/     # API clients
│       ├── components/ui/  # shadcn/ui components
│       ├── features/ # Feature modules
│       └── types/    # TypeScript types
├── executor/         # Task executor
│   ├── agents/       # Agent implementations
│   └── tasks/        # Task handlers
├── executor_manager/ # Orchestration
│   ├── executors/    # Executor lifecycle
│   └── scheduler/    # Task scheduling
└── shared/           # Common utilities
    ├── models/       # Shared models
    └── utils/        # Utility functions
```

---

## 🔧 Module-Specific Guidance

### Backend

**Tech:** FastAPI, SQLAlchemy, Pydantic, MySQL, Redis, Alembic

**Common tasks:**
- Add endpoint: Create in `app/api/`, schema in `app/schemas/`, logic in `app/services/`
- Add model: Create in `app/models/`, generate migration with Alembic

**Environment variables:** `DATABASE_URL`, `REDIS_URL`, `SECRET_KEY`

#### Database Migrations (Alembic)

**Migration workflow:**
```bash
cd backend

# Create migration after model changes
alembic revision --autogenerate -m "description of changes"

# Review generated migration in alembic/versions/
# Always verify auto-generated migrations before applying

# Apply migrations
alembic upgrade head

# Check current status
alembic current
```

**Development vs Production:**
- **Development**: Migrations auto-run on startup when `ENVIRONMENT=development` and `DB_AUTO_MIGRATE=True`
- **Production**: Run migrations manually before deployment

**Common commands:**
```bash
# View migration history
alembic history --verbose

# Rollback one version
alembic downgrade -1

# Rollback to specific revision
alembic downgrade <revision_id>

# Preview SQL without applying
alembic upgrade head --sql
```

**Best practices:**
- Always review auto-generated migrations before applying
- Test migrations on copy of production data
- Backup database before production migrations
- Never edit applied migrations - create new one instead
- Keep migrations small and focused

**For detailed migration guide, see:** [`docs/en/guides/developer/database-migrations.md`](docs/en/guides/developer/database-migrations.md)

### Frontend

**Tech:** Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui

**Common tasks:**
- Add page: Create in `src/app/`
- Add API call: Add function in `src/apis/`
- Add component: Use/extend `src/components/ui/`
- Add type: Define in `src/types/`

**Key feature modules:**
- `src/features/settings/` - Settings page components including Models, Teams, Bots
- `src/features/tasks/` - Task management and chat interface
- `src/apis/models.ts` - Model API client (unified models, test connection)

**Environment:** `NEXT_PUBLIC_API_URL` for client-side API calls

### Executor

**Tech:** Python, Claude Code SDK, Agno, Dify API, Docker

**Supported Agent Types:**
- **ClaudeCode**: For code development tasks with Claude Code SDK
- **Agno**: For dialogue and chat tasks
- **Dify**: For external API integration with Dify platform (chat, workflow, chatflow, agent-chat modes)

**Common tasks:**
- Add agent type: Implement in `agents/`
- Modify execution: Update `tasks/`

**Environment Variables:**
- Claude Code: `ANTHROPIC_AUTH_TOKEN`
- Agno: `ANTHROPIC_API_KEY`
- Dify: `DIFY_API_KEY`, `DIFY_BASE_URL`

### Executor Manager

**Tech:** Python, Docker SDK, FastAPI

**Environment:** `TASK_API_DOMAIN`, `EXECUTOR_IMAGE`, `MAX_CONCURRENT_TASKS`, `NETWORK`

---

## 🔧 Model Management

### Model Types

Wegent supports two types of AI models:

| Type | Description | Storage |
|------|-------------|---------|
| **Public** | System-provided models, shared across all users | `public_models` table |
| **User** | User-defined private models | `kinds` table (kind='Model') |

### Model Resolution Order

When a Bot executes a task, models are resolved in this order:
1. Task-level model override (if `force_override_bot_model` is true)
2. Bot's `bind_model` from `agent_config`
3. Bot's `modelRef` (legacy)
4. Default model

### Key APIs

- `GET /api/models/unified` - List all available models (public + user)
- `GET /api/models/unified/{name}` - Get specific model by name
- `POST /api/models/test-connection` - Test model API connection
- `GET /api/models/compatible?agent_name=X` - Get models compatible with agent type

### Bot Model Binding

Two ways to bind models to Bots:

```yaml
# Method 1: Using modelRef (legacy)
spec:
  modelRef:
    name: model-name
    namespace: default

# Method 2: Using bind_model (recommended)
spec:
  agent_config:
    bind_model: "my-model"
    bind_model_type: "user"  # Optional: 'public' or 'user'
```

---

## 🔒 Security

- Never commit credentials - use `.env` files (excluded from git)
- Frontend: Only use `NEXT_PUBLIC_*` for client-safe values
- Backend encrypts Git tokens before database storage
- Change default passwords in production (`docker-compose.yml`)

---

## 🐛 Debugging

```bash
# Backend logs
docker logs -f wegent-backend

# Frontend verbose mode
npm run dev -- --debug

# Executor logs
docker logs -f <executor-container-id>

# Database access
docker exec -it wegent-mysql mysql -u root -p123456 task_manager

# Redis access
docker exec -it wegent-redis redis-cli
```

**Common issues:**
- Database connection failed: Check MySQL is running, verify credentials
- Port in use: Change ports in `docker-compose.yml`
- Import errors: Activate venv, reinstall dependencies

---

## 📖 Resources

- **Main README**: Project overview and quick start
- **CONTRIBUTING.md**: Detailed contribution guidelines
- **API Docs**: http://localhost:8000/api/docs (when backend running)
- **Testing Guide**: `docs/en/guides/developer/testing.md`
- **Setup Guide**: `docs/en/guides/developer/setup.md`

---

## 🎯 Quick Reference

```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose down

# View logs
docker-compose logs -f [service]

# Run tests
cd backend && pytest
cd frontend && npm test

# Format code
cd backend && black . && isort .
cd frontend && npm run format

# Rebuild service
docker-compose up -d --build [service]
```

**Ports:** 3000 (frontend), 8000 (backend), 8001 (executor manager), 3306 (MySQL), 6379 (Redis)

---

**Last Updated**: 2025-07
**Wegent Version**: 1.0.8
**Maintained by**: WeCode-AI Team

