# Wegent AI Agent Documentation System

Quick reference documentation for AI agents working on Wegent.

---

## Core Documentation

1. **[agents.md](./agents.md)** - AI Agent Roles (5 specialized roles)
2. **[architecture.md](./architecture.md)** - System Architecture  
3. **[tech-stack.md](./tech-stack.md)** - Technology Stack
4. **[design-system.md](./design-system.md)** - UI Design System
5. **[api-conventions.md](./api-conventions.md)** - API Standards
6. **[code-style.md](./code-style.md)** - Coding Standards
7. **[testing-guide.md](./testing-guide.md)** - Testing Practices

## Implementation Examples

8. **[frontend-examples.md](./frontend-examples.md)** - Frontend Patterns
9. **[backend-examples.md](./backend-examples.md)** - Backend Patterns
10. **[fullstack-examples.md](./fullstack-examples.md)** - Full-Stack Patterns
11. **[testing-examples.md](./testing-examples.md)** - Testing Patterns
12. **[documentation-examples.md](./documentation-examples.md)** - Documentation Patterns

---

## Quick Start

### 1. Identify Your Role
Read [agents.md](./agents.md) - Choose from 5 roles:
- **Frontend Developer Agent** - React/Next.js/Tailwind CSS
- **Backend Developer Agent** - FastAPI/SQLAlchemy/MySQL
- **Fullstack Developer Agent** - End-to-end features
- **Testing Agent** - Jest/pytest testing
- **Documentation Agent** - Technical docs

### 2. Understand the System
- [architecture.md](./architecture.md) - System overview
- [tech-stack.md](./tech-stack.md) - Technologies used
- [api-conventions.md](./api-conventions.md) - API design

### 3. Follow Standards
- [code-style.md](./code-style.md) - Naming conventions, patterns
- [design-system.md](./design-system.md) - UI components, colors
- [testing-guide.md](./testing-guide.md) - Testing requirements

### 4. Use Examples
- Check relevant *-examples.md for your role
- Follow code patterns (not tutorials)
- Adapt to your specific task

---

## File Locations

**Frontend**: `/workspace/12738/Wegent/frontend/src/`
- `components/ui/` - shadcn/ui components
- `features/` - Feature modules
- `app/` - Next.js pages
- `apis/` - API clients

**Backend**: `/workspace/12738/Wegent/backend/app/`
- `api/endpoints/` - FastAPI routes
- `services/` - Business logic
- `repository/` - Data access
- `models/` - SQLAlchemy models

**Tests**:
- Frontend: `frontend/src/**/__tests__/`
- Backend: `backend/tests/`

---

## Key Concepts

**Resources** (Kubernetes-style):
- **Ghost** - Agent personality/capabilities
- **Bot** - Complete agent (Ghost + Model + Shell)
- **Team** - Collaboration group
- **Workspace** - Code repository environment
- **Task** - Executable work unit

**Collaboration Models**:
- **Pipeline** - Sequential (A → B → C)
- **Route** - Leader routes to appropriate bot
- **Coordinate** - Leader coordinates parallel execution
- **Collaborate** - Free discussion with shared context

---

## Tech Stack Summary

**Frontend**: Next.js 15, React 19, TypeScript 5.7, Tailwind CSS, shadcn/ui  
**Backend**: FastAPI, Python 3.9+, SQLAlchemy 2.0, MySQL 9.4, Redis 7  
**Testing**: Jest 29, pytest 7.4+

See [tech-stack.md](./tech-stack.md) for complete list.

---

## Quality Standards

- 80%+ test coverage
- Type hints (Python) / TypeScript types
- Follow naming conventions
- Handle errors gracefully
- Never commit credentials

---

## Documentation Stats

Total: 13 files, ~123KB (agent-optimized)

| File | Size | Type |
|------|------|------|
| agents.md | 5.2KB | Reference |
| architecture.md | 25KB | Reference |
| tech-stack.md | 3.6KB | Reference |
| design-system.md | 4.9KB | Reference |
| api-conventions.md | 19KB | Standards |
| code-style.md | 21KB | Standards |
| testing-guide.md | 21KB | Standards |
| frontend-examples.md | 5.4KB | Patterns |
| backend-examples.md | 4.6KB | Patterns |
| fullstack-examples.md | 4.8KB | Patterns |
| testing-examples.md | 4.5KB | Patterns |
| documentation-examples.md | 4.4KB | Patterns |

---

## Related Resources

- Agent Instructions: `/.claude/instructions.md`
- User Docs: `/docs/en/` and `/docs/zh/`
- API Reference: `/api/docs` (when server running)

---

**Last Updated**: 2025-01-22 | **Version**: 1.0.0

Optimized for AI agents: Quick reference, minimal tokens, maximum efficiency.
