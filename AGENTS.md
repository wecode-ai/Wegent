# AGENTS.md

AI coding agent instructions for Wegent project.

---

## Project Overview

**Wegent** is an AI-native operating system for building collaborative AI agent teams.

- **Architecture**: Kubernetes-style declarative API with CRD pattern
- **Frontend**: Next.js 15 + React 19 + TypeScript + Tailwind CSS
- **Backend**: FastAPI + Python + SQLAlchemy + MySQL + Redis
- **Core Concepts**: Ghost (personality), Bot (agent), Team (collaboration), Task (work unit)

---

## Setup Commands

### Frontend
```bash
cd frontend
npm install
npm run dev          # Start dev server (http://localhost:3000)
npm test             # Run tests
npm run lint         # Lint code
npm run format       # Format code
```

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload  # Start dev server (http://localhost:8000)
pytest                         # Run tests
black . && isort .             # Format code
flake8 && mypy .              # Lint and type check
```

### Full Stack
```bash
docker-compose up -d   # Start all services (MySQL, Redis, Backend, Frontend)
docker-compose logs -f # View logs
docker-compose down    # Stop all services
```

---

## Code Style

### Frontend (TypeScript/React)
- **Language**: TypeScript 5.7+ with strict mode
- **Naming**:
  - Variables/functions: `camelCase`
  - Components: `PascalCase`
  - Files: `kebab-case.tsx`
- **Formatting**: Prettier (single quotes, 2 spaces, no semicolons)
- **Components**: Functional components with hooks, no class components
- **Styling**: Tailwind CSS utility classes, follow design system in `docs/design-system.md`
- **Imports**: Group by: React → external → internal → types → styles

### Backend (Python)
- **Language**: Python 3.9+
- **Style**: PEP 8, use `black` + `isort` for formatting
- **Naming**:
  - Variables/functions: `snake_case`
  - Classes: `PascalCase`
  - Constants: `UPPER_CASE`
- **Type Hints**: Always use type hints for function parameters and returns
- **Docstrings**: Google-style docstrings for all public functions/classes
- **Async**: Prefer async/await for I/O operations

### Git Commits
- **Format**: `type(scope): description`
- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- **Examples**:
  - `feat(frontend): add dark mode toggle`
  - `fix(backend): resolve JWT token expiration issue`
  - `docs(agent): update API documentation`

---

## Testing Instructions

### Frontend Tests
- **Framework**: Jest 29 + React Testing Library
- **Location**: `frontend/src/**/__tests__/` or `*.test.tsx`
- **Run**: `npm test` or `npm run test:coverage`
- **Coverage**: Aim for 80%+ coverage
- **Patterns**:
  - Use `render()` from Testing Library
  - Use `screen` queries (not `container`)
  - Test user interactions with `userEvent`
  - Mock API calls with MSW

### Backend Tests
- **Framework**: pytest 7.4+
- **Location**: `backend/tests/`
- **Run**: `pytest` or `pytest --cov`
- **Coverage**: Aim for 80%+ coverage
- **Patterns**:
  - Use fixtures for setup/teardown
  - Use `pytest-asyncio` for async tests
  - Mock external services
  - Test AAA pattern (Arrange-Act-Assert)

### Before Committing
Always run:
```bash
# Frontend
npm run lint && npm test

# Backend
black . && isort . && flake8 && mypy . && pytest
```

---

## Architecture Guidelines

### Frontend Structure
```
frontend/src/
├── app/           # Next.js App Router pages
├── components/    # Reusable UI components
│   └── ui/       # shadcn/ui components
├── features/      # Feature-specific modules
├── apis/          # API client functions
├── hooks/         # Custom React hooks
├── lib/           # Utilities and helpers
└── types/         # TypeScript type definitions
```

### Backend Structure
```
backend/app/
├── api/           # FastAPI route handlers
│   └── endpoints/
├── services/      # Business logic layer
├── repository/    # Database access layer
├── models/        # SQLAlchemy ORM models
├── schemas/       # Pydantic request/response schemas
└── core/          # Config, security, dependencies
```

### Data Flow
```
Frontend Component → API Client → FastAPI Endpoint → Service → Repository → Model → Database
```

---

## API Conventions

### RESTful Design
- **Resources**: Use plural nouns (`/api/v1/bots`, `/api/v1/teams`)
- **Methods**: GET (read), POST (create), PUT (update), DELETE (remove)
- **Status Codes**: 200 (OK), 201 (Created), 400 (Bad Request), 401 (Unauthorized), 404 (Not Found), 500 (Server Error)

### Request/Response Format
```python
# Request (Pydantic schema)
class BotCreate(BaseModel):
    name: str
    ghost_ref: GhostReference
    shell_ref: ShellReference
    model_ref: ModelReference

# Response
class BotResponse(BaseModel):
    id: int
    name: str
    status: str
    created_at: datetime
```

### Authentication
- **Method**: JWT tokens in `Authorization: Bearer <token>` header
- **Endpoints**: All API endpoints require authentication except `/auth/login`, `/auth/register`
- **Token Expiration**: 24 hours (configurable)

---

## Design System

### Colors (Calm UI - Low Saturation)
- **Primary**: `#14B8A6` (Mint blue)
- **Background**: Light `#FFFFFF`, Dark `#0E0F0F`
- **Text**: Light `#1A1A1A`, Dark `#ECECEC`
- **Use**: CSS variables (`--color-bg-base`, `--color-text-primary`, etc.)

### Spacing
- Use Tailwind spacing scale: `p-2` (8px), `p-3` (12px), `p-4` (16px), `p-6` (24px)
- Card spacing: `space-y-3` (12px between cards)

### Components
- **Location**: `frontend/src/components/ui/`
- **Library**: shadcn/ui (Radix UI + Tailwind CSS)
- **Key Components**: Button, Card, Input, Dialog, Dropdown, Toast, Form
- **Reference**: Follow ChatArea component in `/code` page as design standard

---

## Security Considerations

- **Never commit credentials**: Use environment variables for all secrets
- **Validate inputs**: Use Zod (frontend) and Pydantic (backend) for validation
- **Sanitize data**: Prevent XSS by sanitizing HTML content
- **SQL Injection**: Always use parameterized queries (SQLAlchemy ORM handles this)
- **Rate Limiting**: Implement rate limiting on API endpoints
- **CORS**: Configure CORS properly in FastAPI settings

---

## Common Tasks

### Add a New Feature (Fullstack)

1. **Backend**: Create model → schema → repository → service → endpoint
2. **Frontend**: Create API client → hook → component → page
3. **Tests**: Write tests for backend service and frontend component
4. **Docs**: Update API documentation

### Add a New UI Component

1. Use shadcn/ui CLI: `npx shadcn-ui@latest add <component>`
2. Customize in `frontend/src/components/ui/`
3. Follow design system colors and spacing
4. Add to Storybook (if applicable)

### Add a New API Endpoint

1. Create Pydantic schemas in `schemas/`
2. Add route handler in `api/endpoints/`
3. Implement business logic in `services/`
4. Add database queries in `repository/`
5. Write pytest tests in `tests/`

---

## Debugging Tips

### Frontend
- Use React DevTools for component inspection
- Check browser console for errors
- Use `console.log()` or debugger breakpoints
- Check Network tab for API call failures

### Backend
- Check FastAPI auto-generated docs at `/docs` (Swagger UI)
- Use `structlog` for structured logging
- Check Docker logs: `docker-compose logs backend`
- Use `pdb` for debugging: `import pdb; pdb.set_trace()`

---

## Environment Variables

### Frontend (`.env.local`)
```
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_APP_NAME=Wegent
```

### Backend (`.env`)
```
DATABASE_URL=mysql+pymysql://user:password@localhost:3306/wegent_db
REDIS_URL=redis://localhost:6379/0
SECRET_KEY=your-secret-key
ANTHROPIC_API_KEY=your-api-key
```

---

## PR Instructions

### Before Creating PR

1. Run all tests: `npm test` (frontend), `pytest` (backend)
2. Run linters: `npm run lint`, `black . && isort . && flake8`
3. Ensure no TypeScript/mypy errors
4. Update relevant documentation

### PR Format

- **Title**: `type(scope): description` (e.g., `feat(frontend): add settings page`)
- **Description**:
  - What changed and why
  - Screenshots for UI changes
  - Breaking changes (if any)
  - Related issues

### Review Checklist

- [ ] Tests pass
- [ ] Code follows style guidelines
- [ ] No console.log or debug statements
- [ ] Type hints/types added
- [ ] Documentation updated
- [ ] No credentials committed

---

## Resources

- **User Docs**: `/docs/en/` (English), `/docs/zh/` (Chinese)
- **API Docs**: `http://localhost:8000/docs` (when backend running)
- **Design System**: `/docs/design-system.md`
- **Architecture**: `/docs/en/concepts/architecture.md`

---

## Tech Stack

**Frontend**: Next.js 15, React 19, TypeScript 5.7, Tailwind CSS 3.4, shadcn/ui, Radix UI, lucide-react, react-hook-form, Zod, i18next
**Backend**: FastAPI, Python 3.9+, SQLAlchemy 2.0, PyMySQL, Alembic, PyJWT, Redis, httpx
**Database**: MySQL 9.4, Redis 7
**Testing**: Jest 29, React Testing Library, pytest 7.4+, pytest-asyncio
**DevOps**: Docker, docker-compose

---

**Last Updated**: 2025-01-22 | **Version**: 1.0.0
