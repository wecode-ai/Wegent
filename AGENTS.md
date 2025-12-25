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

### Testing Requirements for PRs

**⚠️ ALL PRs adding new functionality MUST include tests:**

**Backend testing requirements:**
- Test new API endpoints (happy path + error cases)
- Test service layer business logic
- Test database operations with fixtures
- Test multi-item processing (e.g., multiple attachments, batch operations)
- Mock external API calls (LLM APIs, external services)

**Frontend testing requirements:**
- Test new custom hooks with React Testing Library
- Test new components (render, interaction, state changes)
- Test error states and loading states
- Test file upload workflows (single and multiple files)
- Test WebSocket/real-time features

**Example test structure:**
```python
# backend/tests/services/chat/test_ai_trigger.py
async def test_process_multiple_attachments():
    """Test processing multiple text and image attachments together"""
    # Arrange: Create attachments
    # Act: Call _process_attachments()
    # Assert: Check combined message format

async def test_process_attachments_handles_failures():
    """Test partial attachment processing failures"""
    # Assert: Verify error handling and user feedback
```

```typescript
// frontend/src/hooks/__tests__/useMultiAttachment.test.ts
test('handles multiple file uploads in parallel', async () => {
  // Test concurrent upload tracking
})

test('tracks per-file progress correctly', async () => {
  // Test progress state updates
})

test('handles per-file errors independently', async () => {
  // Test error isolation
})
```

---

## 💻 Code Style

**⚠️ All code comments MUST be written in English.**

### General Principles

- **High cohesion, low coupling**: Each module/class should have a single responsibility
- **File size limit**: If a file exceeds **1000 lines**, split it into multiple sub-modules
- **Function length**: Max 50 lines per function (preferred)
- **Avoid duplication**: Extract common logic into shared utilities

**⚠️ Code Duplication Prevention:**
- If the same function exists in multiple services (e.g., `chat/` and `chat_v2/`), extract it to a shared module
- Example: Extract `_process_attachments()` to `app/services/attachment/multi_processor.py`
- Before copying code, check if a utility function exists or should be created
- Use imports instead of copy-paste

**Error Handling Best Practices:**
- Don't silently skip errors - log AND notify users when operations fail
- For partial failures (e.g., processing multiple items), track which items failed
- Return structured error information to the frontend for user feedback
- Example:
  ```python
  # ❌ Bad: Silent failure
  except Exception as e:
      logger.error(f"Failed: {e}")
      continue  # User doesn't know what failed

  # ✅ Good: Track and report failures
  except Exception as e:
      logger.error(f"Failed to process item {id}: {e}")
      failed_items.append({"id": id, "error": str(e)})

  return {"success": processed_items, "failed": failed_items}
  ```

**Type Safety:**
- Use proper type annotations (avoid `Any` when possible)
- Return type annotations must match actual return values
- Example:
  ```python
  # ❌ Bad: Annotation doesn't match return
  def process_data() -> str:
      return {"data": "value"}  # Actually returns dict

  # ✅ Good: Accurate annotation
  def process_data() -> Union[str, dict[str, Any]]:
      return {"data": "value"}
  ```

### Python (Backend, Executor, Shared)

**Standards:** PEP 8, Black formatter (line length: 88), isort, type hints required

```bash
black . && isort .
```

**Guidelines:**
- Descriptive names, docstrings for public functions/classes
- Extract magic numbers to constants

**Docstring Requirements:**
- All public functions/classes MUST have docstrings
- Target docstring coverage: 80%+ (minimum 50%)
- Include:
  - Brief description of purpose
  - Args: Parameter descriptions with types
  - Returns: Return value description with type
  - Raises: Exceptions that may be raised
  - Example usage (for complex functions)

```python
# ✅ Good: Complete docstring
async def process_multiple_attachments(
    db: Session,
    attachment_ids: list[int],
    user_id: int,
    message: str,
) -> Union[str, dict[str, Any]]:
    """
    Process multiple attachments and build message with all attachment contents.

    Separates image attachments from text documents and formats them appropriately
    for vision model input or text concatenation.

    Args:
        db: Database session (SQLAlchemy Session)
        attachment_ids: List of attachment IDs to process
        user_id: User ID for authorization
        message: Original message text from user

    Returns:
        - str: Message with text attachments prepended (if only text)
        - dict: Multi-vision structure with images (if any images present)
          Format: {"type": "multi_vision", "text": str, "images": list}

    Raises:
        AttachmentNotFoundError: If attachment doesn't exist
        AuthorizationError: If user doesn't own attachment

    Example:
        >>> result = await process_multiple_attachments(db, [1, 2], 123, "Analyze these")
        >>> # Returns: {"type": "multi_vision", "text": "...", "images": [...]}
    """
```

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

**Component Separation Principles:**
- Separate button/input components from preview/display components
- Use single responsibility principle - one component, one job
- Avoid `showXOnly` props - create separate components instead
- Example (File upload):
  - `AttachmentButton` - only handles file selection
  - `AttachmentUploadPreview` - only displays upload progress and previews
  - Better than `MultiFileUpload` with `showButtonOnly`/`showPreviewOnly` props

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

### PR Documentation Requirements

**⚠️ PRs with new/changed functionality MUST update documentation:**

**API Changes:**
- Update OpenAPI/Swagger docs if adding/modifying endpoints
- Document new request/response schemas
- Update API version if breaking changes

**User-Facing Changes:**
- Update user guide in `docs/zh/` (Chinese) and `docs/en/` (English)
- Add screenshots for UI changes
- Document new features with examples

**Configuration Changes:**
- Update `.env.example` with new environment variables
- Document default values and valid options
- Add comments explaining purpose

**Architecture Changes:**
- Update `AGENTS.md` or `docs/architecture.md`
- Document new CRD types or spec changes
- Update system diagrams if relationships change

**Deprecations:**
- Mark deprecated fields/endpoints in code and docs
- Add migration guide for breaking changes
- Document timeline for removal

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

### Backward Compatibility Guidelines

**⚠️ When adding new fields or parameters:**

**Maintain old fields during transition:**
```python
# ✅ Good: Support both old and new fields
class ChatPayload(BaseModel):
    attachment_id: Optional[int] = None  # Deprecated but supported
    attachment_ids: Optional[list[int]] = None  # New field

# Handle both in code
attachment_ids_to_process = []
if payload.attachment_ids:
    attachment_ids_to_process = payload.attachment_ids
elif payload.attachment_id:
    attachment_ids_to_process = [payload.attachment_id]  # Convert old format
```

**Deprecation process:**
1. Add new field/parameter
2. Keep old field with deprecation marker in code comments
3. Support both for at least 2 major versions
4. Log warnings when old field is used
5. Remove old field in documented breaking release

**API versioning:**
- Mark deprecated fields in API docs
- Include migration examples
- Consider API version routes for major breaking changes

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

## ⚡ Performance Considerations

### Database Operations

**Batch operations when possible:**
```python
# ❌ Bad: N individual queries
for attachment_id in attachment_ids:
    link_attachment_to_subtask(db, attachment_id, subtask_id)

# ✅ Good: Single batch operation
link_multiple_attachments_to_subtask(db, attachment_ids, subtask_id)
```

**Use database indexes:**
- Index foreign keys and frequently queried columns
- Add indexes in migration files
- Monitor query performance with `EXPLAIN`

### Frontend Performance

**Image optimization:**
- Use authenticated blob URLs for image previews
- Clean up blob URLs with `URL.revokeObjectURL()` in cleanup functions
- Lazy load images for large lists

**WebSocket/Real-time:**
- Debounce frequent socket events
- Use pagination for large message histories
- Clean up socket listeners in component unmount

**State management:**
- Avoid unnecessary re-renders with `useCallback`, `useMemo`
- Use context sparingly for deeply nested prop drilling only
- Consider component splitting for large forms

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
