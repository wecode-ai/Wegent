# AGENTS.md

Wegent is an open-source AI-native operating system for defining, organizing, and running intelligent agent teams.

---

## 📋 Project Overview

**Multi-module architecture:**
- **Backend** (FastAPI + SQLAlchemy + MySQL): RESTful API and business logic
- **Frontend** (Next.js 15 + TypeScript + React 19): Web UI with shadcn/ui components
- **Executor**: Task execution engine (Claude Code, Agno, Dify, ImageValidator)
- **Executor Manager**: Task orchestration via Docker
- **Chat Shell**: Lightweight AI chat engine for Chat Shell type (LangGraph + multi-LLM)
- **Shared**: Common utilities, models, and cryptography

**Core principles:**
- Kubernetes-inspired CRD design (Ghost, Model, Shell, Bot, Team, Task, Skill, Workspace)
- System should be simple AFTER your work - prioritize code simplicity and extensibility

**📚 Documentation Principle:**
- **AGENTS.md**: Core concepts, coding principles, and quick reference only
- **docs/**: Detailed architecture, design documents, and comprehensive guides
- When adding new features, put detailed docs in `docs/en/` and `docs/zh/`, reference from AGENTS.md

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

**⚠️ Python modules use [uv](https://docs.astral.sh/uv/) for dependency management. Always use `uv run` to execute Python commands.**


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

### Code Design Guidelines

⚠️ **Follow these guidelines when implementing new features or modifying existing code:**

1. **Long-term maintainability over short-term simplicity**: When multiple implementation approaches exist, avoid solutions that are simpler to implement now but will increase maintenance costs in the long run. Choose the approach that balances implementation effort with long-term sustainability.

2. **Use design patterns for decoupling**: Actively consider applying design patterns (e.g., Strategy, Factory, Observer, Adapter) to decouple modules and improve code flexibility. This makes the codebase easier to extend and test.

3. **Manage complexity through extraction**: If a module is already complex, prioritize extracting common logic into utilities or creating new modules rather than adding more complexity to the existing module. When in doubt, split rather than extend.

4. **Reference, extract, then reuse**: Before implementing new functionality, always:
   - Search for existing implementations that solve similar problems
   - Extract reusable patterns from existing code if found
   - Create shared utilities that can be reused across the codebase
   - Never copy-paste code or write duplicate logic

5. **Refactor before extending**: When analyzing code, identify features related to the new functionality. If related code exists, refactor it using design patterns and extract common methods before adding new features - never re-implement existing logic.

6. **Fix all discovered issues**: When you discover a problem during development, you MUST fix it immediately. Never ignore issues because they seem "unrelated" to the current task - all bugs found must be addressed. **Proactively review** code and documentation for issues - don't wait for users to point them out.

7. **Prefer industry standards over project conventions**: If the project has practices that deviate from industry standards, adopt the standard approach rather than extending non-standard patterns. This improves code maintainability and reduces onboarding friction for new developers.

8. **Delete dead code aggressively**: Regardless of the effort required, ensure that deprecated, unused, or obsolete code is removed. Dead code degrades maintainability and creates confusion - keeping the codebase clean is non-negotiable.

9. **Extract common logic from ALL code**: When making changes and you discover logic that should be extracted into shared utilities, do it immediately. This applies to ALL code - not just "new code reusing old code", but also extracting commonalities between existing code segments. Every opportunity for reuse must be taken.

10. **Avoid backward compatibility - design for the ideal state**: When implementing changes, design as if there is no legacy burden - consider "what would be the best approach if we were starting fresh". Avoid writing compatibility shims or workarounds for old logic. If backward compatibility is absolutely unavoidable, consult with the user before proceeding.

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

### Responsive Architecture

⚠️ **Wegent uses a mobile-first, component-separation architecture for responsive design**

**Breakpoint System:**
- Mobile: ≤767px - Touch-optimized UI with drawer sidebar
- Tablet: 768px-1023px - Uses desktop layout
- Desktop: ≥1024px - Full-featured UI with all controls

**When to Separate Components:**
- Layout differences >30%: Create separate Mobile/Desktop components
- Different interaction patterns: Separate for better UX
- Performance optimization: Use code splitting via dynamic imports

**When to Use Tailwind Responsive Classes:**
- Simple styling adjustments (spacing, font size)
- Show/hide scenarios
- Minor layout changes

**Page-Level Separation Pattern:**
```
app/(tasks)/chat/
├── page.tsx                 # Router component (dynamic imports)
├── ChatPageDesktop.tsx      # Desktop implementation
└── ChatPageMobile.tsx       # Mobile implementation
```

**Component-Level Separation Pattern:**
```typescript
// ChatInputControls.tsx (contains routing logic)
export function ChatInputControls(props: Props) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <MobileChatInputControls {...props} />
  }

  return <DesktopChatInputControls {...props} />
}
```

**Touch-Friendly Requirements (Mobile):**
- All interactive elements must be at least 44px × 44px
- Use `h-11 min-w-[44px]` for buttons
- Example: `<Button className="h-11 min-w-[44px] px-4">...</Button>`

**📖 Detailed Documentation:** See [`docs/en/guides/responsive-development.md`](docs/en/guides/responsive-development.md) or [`docs/zh/guides/responsive-development.md`](docs/zh/guides/responsive-development.md)

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

### Button Variants

⚠️ **Primary action buttons in dialogs MUST use `variant="primary"`**

When a dialog contains action buttons (e.g., Save, Create, Confirm), the main action button must explicitly use `variant="primary"` to ensure visual consistency and proper styling.

```tsx
// ✅ CORRECT - Primary action button in dialog
<DialogFooter>
  <Button variant="outline" onClick={onCancel}>Cancel</Button>
  <Button variant="primary" onClick={onSave}>Save</Button>
</DialogFooter>

// ❌ WRONG - Missing variant on primary action
<DialogFooter>
  <Button variant="outline" onClick={onCancel}>Cancel</Button>
  <Button onClick={onSave}>Save</Button>  // Missing variant="primary"
</DialogFooter>
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
| **Skill** | On-demand capabilities | `description`, `prompt`, `tools`, `provider` |

### Database Table Mapping

⚠️ **Important:** Task and Workspace resources are stored in a **separate `tasks` table**, not in the `kinds` table.

| CRD Kind | Database Table | Model Class |
|----------|----------------|-------------|
| Ghost, Model, Shell, Bot, Team, Skill | `kinds` | `Kind` |
| **Task, Workspace** | **`tasks`** | **`TaskResource`** |
| **Skill Binary** | **`skill_binaries`** | **`SkillBinary`** |

**Code Usage:**
```python
# For Task/Workspace - use TaskResource model
from app.models.task import TaskResource
task = db.query(TaskResource).filter(TaskResource.kind == "Task", ...).first()

# For other CRDs (Ghost, Model, Shell, Bot, Team) - use Kind model
from app.models.kind import Kind
team = db.query(Kind).filter(Kind.kind == "Team", ...).first()
```

**Migration Note:** This separation was introduced to improve query performance and data management for Task/Workspace resources which have higher query frequency.

### Shell Types

| Type | Description |
|------|-------------|
| `ClaudeCode` | Claude Code SDK in Docker |
| `Agno` | Agno framework in Docker |
| `Dify` | External Dify API proxy |
| `Chat` | Direct LLM API (no Docker) |

---

## 🎯 Skill System

**Skill** is a CRD that provides on-demand capabilities and tools to AI Agents. Skills are loaded dynamically when the LLM determines they are needed, improving token efficiency.

**Key Points:**
- Skills are referenced by name in `Ghost.spec.skills[]`
- Uploaded as ZIP packages with `SKILL.md` (metadata + prompt)
- Can include custom tool providers (public skills only)
- Loaded on-demand via `load_skill()` tool call

**📖 For detailed documentation:** See [`docs/en/concepts/skill-system.md`](docs/en/concepts/skill-system.md) or [`docs/zh/concepts/skill-system.md`](docs/zh/concepts/skill-system.md)

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
uv run alembic revision --autogenerate -m "description"  # Create
uv run alembic upgrade head                               # Apply
uv run alembic downgrade -1                               # Rollback
```

### Frontend

**Tech:** Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui, i18next

**State Management (Context-based):**
- `UserContext` - User auth state
- `TaskContext` - Task list, pagination
- `ChatStreamContext` - WebSocket streaming
- `SocketContext` - Socket.IO connection
- `ThemeContext` - Theme (light/dark)

**Message Data Flow (Chat/Task Messages):**

⚠️ **CRITICAL: Single Source of Truth for Messages**

When working with chat messages, always use `messages` from `useUnifiedMessages` - this is the **ONLY** source of truth for displayed messages.

```typescript
// ✅ CORRECT - Use messages from useUnifiedMessages
const { messages } = useUnifiedMessages({ team, isGroupChat });

// ❌ WRONG - Do NOT use selectedTaskDetail.subtasks for display/export
// This is stale backend data that doesn't include WebSocket updates
```

**Message Data Sources:**

| Source | Contains | Use Case |
|--------|----------|----------|
| `messages` (from `useUnifiedMessages`) | Real-time messages via WebSocket | ✅ Display, export, UI rendering |
| `selectedTaskDetail.subtasks` | Backend cached data | ❌ NEVER use for display/export |

**Message Flow:**

```
1. Initial Load:
   selectedTaskDetail.subtasks → syncBackendMessages() → streamState.messages

2. New Message (Self):
   sendMessage() → streamState.messages (pending)
   WebSocket chat:start → Add AI message
   WebSocket chat:chunk → Update AI content
   WebSocket chat:done → Mark complete

3. New Message (Other User in Group Chat):
   WebSocket chat:message → streamState.messages (completed)

4. Page Refresh / Task Switch:
   selectedTaskDetail.subtasks → Re-sync to streamState.messages
```

**Key Points:**
- `streamState.messages` is updated by WebSocket events in real-time
- `selectedTaskDetail.subtasks` is only updated when explicitly refreshing task detail
- When exporting/displaying messages, ALWAYS use `messages` from `useUnifiedMessages`
- This ensures all real-time updates (self, other users, AI) are included


**i18n Rules:**

1. **Always import from `@/hooks/useTranslation`**, not from `react-i18next`
2. **Use single namespace** matching your feature (e.g., `useTranslation('groups')` for groups feature)
3. **Translation key format:**
   - Within current namespace: `t('key.subkey')` (e.g., `t('title')`, `t('actions.save')`)
   - From other namespace: `t('namespace:key.subkey')` (e.g., `t('common:actions.save')`, `t('chat:export.title')`)
4. **Never use array with `common` first** - `useTranslation(['common', 'groups'])` will break feature-specific keys
5. **Add new translation keys** to the appropriate namespace file in `src/i18n/locales/{lang}/`

**Examples:**
```typescript
// ✅ CORRECT
const { t } = useTranslation('groups');
t('title')                    // Access current namespace key
t('common:actions.save')      // Access common namespace key
t('chat:export.no_messages')  // Access chat namespace key

// ❌ WRONG
const { t } = useTranslation(['common', 'groups']); // Breaks feature keys
t('actions.save')             // Ambiguous - which namespace?
```

### Executor

**Agent types:**
| Agent | Type | Key Features |
|-------|------|--------------|
| `ClaudeCode` | `local_engine` | Claude Code SDK, Git clone, Skills support, MCP servers, custom instructions (.cursorrules, .windsurfrules) |
| `Agno` | `local_engine` | Team modes (coordinate/collaborate/route), SQLite sessions, MCP support |
| `Dify` | `external_api` | Proxy to Dify (chat/chatflow/workflow/agent-chat modes), no local code execution |
| `ImageValidator` | `validator` | Custom base image validation |

### Executor Manager

**Tech:** Python, Docker SDK, FastAPI, APScheduler

**Deployment Modes:**
- **Docker Mode**: Uses Docker SDK to manage containers locally

**Common tasks:**
- Add executor type: Implement in `executors/`
- Modify orchestration: Update `scheduler/`

### Chat Shell

**Tech:** FastAPI, LangGraph, LangChain, multi-LLM (Anthropic/OpenAI/Google)

**Running Modes:**
- `http` - Independent HTTP service with `/v1/response` API (default)
- `package` - Python package imported by Backend
- `cli` - Command-line interface for interactive chat


---

## 🔒 Security

- Never commit credentials - use `.env` files
- Frontend: Only use `NEXT_PUBLIC_*` for client-safe values
- Backend encrypts Git tokens and API keys (AES-256-CBC)
- OIDC support for enterprise SSO
- Role-based access control for admin operations

---

## 📊 OpenTelemetry Tracing

**Location:** `shared/telemetry/decorators.py`

| Scenario | Method |
|----------|--------|
| Trace entire async function | `@trace_async(span_name, tracer_name, extract_attributes)` |
| Trace entire sync function | `@trace_sync(span_name, tracer_name, extract_attributes)` |
| Add event to current span | `add_span_event(name, attributes)` |
| Set attribute on current span | `set_span_attribute(key, value)` |

---

## 🎯 Quick Reference

```bash
# Start services
docker-compose up -d

# Run tests (Python modules use uv)
cd backend && uv run pytest
cd executor && uv run pytest
cd executor_manager && uv run pytest
cd chat_shell && uv run pytest
cd shared && uv run pytest
cd frontend && npm test

# Format code
cd backend && black . && isort .
cd frontend && npm run format

# Database migration
cd backend && uv run alembic revision --autogenerate -m "msg" && uv run alembic upgrade head
```

**Ports:** 3000 (frontend), 8000 (backend), 8001 (chat shell), 3306 (MySQL), 6379 (Redis)

