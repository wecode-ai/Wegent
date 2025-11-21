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
- **Executor**: Task execution engine (Claude Code, Agno)
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

**Tech:** FastAPI, SQLAlchemy, Pydantic, MySQL, Redis

**Common tasks:**
- Add endpoint: Create in `app/api/`, schema in `app/schemas/`, logic in `app/services/`
- Add model: Create in `app/models/`, restart (auto-creates table)

**Environment variables:** `DATABASE_URL`, `REDIS_URL`, `SECRET_KEY`

### Frontend

**Tech:** Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui

**Common tasks:**
- Add page: Create in `src/app/`
- Add API call: Add function in `src/apis/`
- Add component: Use/extend `src/components/ui/`
- Add type: Define in `src/types/`

**Environment:** `NEXT_PUBLIC_API_URL` for client-side API calls

### Executor

**Tech:** Python, Claude Code SDK, Agno, Docker

**Common tasks:**
- Add agent type: Implement in `agents/`
- Modify execution: Update `tasks/`

**Environment:** `ANTHROPIC_AUTH_TOKEN` (Claude Code) or `ANTHROPIC_API_KEY` (Agno)

### Executor Manager

**Tech:** Python, Docker SDK, FastAPI

**Environment:** `TASK_API_DOMAIN`, `EXECUTOR_IMAGE`, `MAX_CONCURRENT_TASKS`, `NETWORK`

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

**Last Updated**: 2025-01
**Wegent Version**: 1.0.7
**Maintained by**: WeCode-AI Team
