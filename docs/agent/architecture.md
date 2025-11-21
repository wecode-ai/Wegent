# System Architecture

This document provides a comprehensive system architecture reference for AI agents working on the Wegent project. It covers the complete system design, technology stack, data flows, and architectural patterns.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Frontend Structure](#frontend-structure)
3. [Backend Structure](#backend-structure)
4. [Core Concepts](#core-concepts)
5. [Data Flow Patterns](#data-flow-patterns)
6. [Communication Between Layers](#communication-between-layers)
7. [Security Architecture](#security-architecture)
8. [Performance and Scalability](#performance-and-scalability)

---

## Architecture Overview

Wegent follows a **layered architecture** based on Kubernetes-style declarative API and CRD (Custom Resource Definition) design patterns.

### System Layers

```
┌─────────────────────────────────────────┐
│   Frontend Layer (Next.js + React)     │
│   - User interface                      │
│   - Resource visualization              │
│   - Real-time updates                   │
└────────────────┬────────────────────────┘
                 │ HTTP/WebSocket
┌────────────────▼────────────────────────┐
│   Backend Layer (FastAPI + Python)     │
│   - REST API endpoints                  │
│   - Business logic                      │
│   - Authentication                      │
└────────────────┬────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
┌───────▼─────┐  ┌────────▼────────┐
│   MySQL     │  │     Redis       │
│   Database  │  │     Cache       │
└─────────────┘  └─────────────────┘
```

### Technology Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js 15, React 19, TypeScript | User interface |
| **Backend** | FastAPI, Python 3.9+, SQLAlchemy | API and business logic |
| **Database** | MySQL 9.4 | Persistent data storage |
| **Cache** | Redis 7 | Session and temporary data |
| **Executor** | Docker, Claude Code, Agno | Isolated task execution |

---

## Frontend Structure

The frontend is built with **Next.js 15** using the **App Router** architecture.

### Directory Structure

```
frontend/src/
├── app/                    # Next.js App Router
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Home page
│   ├── globals.css         # Global styles
│   ├── login/              # Login page
│   ├── settings/           # Settings page
│   └── (tasks)/            # Task pages (route group)
│       ├── code/           # Code task page
│       ├── chat/           # Chat task page
│       └── tasks/          # Task list page
│
├── components/             # Reusable components
│   ├── common/             # Common components
│   ├── ui/                 # UI primitives (shadcn/ui)
│   ├── I18nProvider.tsx    # i18n provider
│   └── LanguageSwitcher.tsx # Language switcher
│
├── features/               # Feature-specific modules
│   ├── settings/           # Settings feature
│   │   ├── components/     # Settings components
│   │   ├── hooks/          # Settings hooks
│   │   └── utils/          # Settings utilities
│   ├── code-task/          # Code task feature
│   ├── chat-task/          # Chat task feature
│   └── task-list/          # Task list feature
│
├── apis/                   # API client functions
│   ├── auth.ts             # Authentication API
│   ├── ghosts.ts           # Ghost API
│   ├── bots.ts             # Bot API
│   ├── teams.ts            # Team API
│   ├── tasks.ts            # Task API
│   └── workspaces.ts       # Workspace API
│
├── hooks/                  # Custom React hooks
│   ├── useAuth.ts          # Authentication hook
│   ├── useTask.ts          # Task management hook
│   └── useWebSocket.ts     # WebSocket hook
│
├── lib/                    # Utility libraries
│   ├── utils.ts            # General utilities
│   └── cn.ts               # Class name utilities
│
├── types/                  # TypeScript type definitions
│   ├── api.ts              # API types
│   ├── ghost.ts            # Ghost types
│   ├── bot.ts              # Bot types
│   └── task.ts             # Task types
│
├── i18n/                   # Internationalization
│   ├── locales/            # Translation files
│   │   ├── en.json         # English
│   │   └── zh.json         # Chinese
│   └── config.ts           # i18n configuration
│
├── utils/                  # Utility functions
│   ├── format.ts           # Formatting utilities
│   ├── validation.ts       # Validation utilities
│   └── constants.ts        # Constants
│
└── config/                 # Configuration files
    └── site.ts             # Site configuration
```

### Key Frontend Patterns

**1. App Router File-Based Routing**
- `app/page.tsx` → `/`
- `app/login/page.tsx` → `/login`
- `app/settings/page.tsx` → `/settings`
- `app/(tasks)/code/page.tsx` → `/code`

**2. Server Components vs Client Components**
- Server Components: Default, for static content
- Client Components: Mark with `"use client"` for interactivity

**3. API Integration**
- API client functions in `apis/` directory
- Use `fetch` or custom HTTP client
- Handle authentication with JWT tokens

**4. State Management**
- Local state: `useState`, `useReducer`
- Global state: React Context or custom hooks
- Form state: `react-hook-form` with `zod` validation

---

## Backend Structure

The backend is built with **FastAPI** following a layered architecture pattern.

### Directory Structure

```
backend/app/
├── main.py                 # Application entry point
├── __init__.py
│
├── core/                   # Core functionality
│   ├── config.py           # Configuration management
│   ├── security.py         # Authentication & security
│   ├── logging.py          # Logging configuration
│   ├── exceptions.py       # Custom exceptions
│   ├── cache.py            # Redis cache utilities
│   └── yaml_init.py        # YAML initialization
│
├── api/                    # API layer
│   ├── api.py              # API router aggregation
│   └── endpoints/          # API endpoints
│       ├── auth.py         # Authentication endpoints
│       ├── oidc.py         # OIDC/OAuth endpoints
│       ├── admin.py        # Admin endpoints
│       ├── repository.py   # Repository endpoints
│       ├── quota.py        # Quota endpoints
│       ├── subtasks.py     # Subtask endpoints
│       ├── kind/           # CRD endpoints
│       │   ├── kinds.py    # Generic CRD operations
│       │   ├── common.py   # Common CRD logic
│       │   └── batch.py    # Batch operations
│       └── adapter/        # Adapter endpoints
│           ├── executors.py # Executor adapter
│           └── agents.py   # Agent adapter
│
├── models/                 # Database models (SQLAlchemy)
│   ├── user.py             # User model
│   ├── ghost.py            # Ghost model
│   ├── model.py            # Model model
│   ├── shell.py            # Shell model
│   ├── bot.py              # Bot model
│   ├── team.py             # Team model
│   ├── workspace.py        # Workspace model
│   └── task.py             # Task model
│
├── schemas/                # Pydantic schemas
│   ├── kind.py             # CRD schemas
│   ├── user.py             # User schemas
│   └── ...                 # Other schemas
│
├── services/               # Business logic layer
│   ├── user.py             # User service
│   ├── ghost.py            # Ghost service
│   ├── bot.py              # Bot service
│   ├── team.py             # Team service
│   ├── workspace.py        # Workspace service
│   ├── task.py             # Task service
│   └── kind/               # CRD services
│       └── common.py       # Common CRD operations
│
├── repository/             # Data access layer
│   ├── github_provider.py  # GitHub integration
│   ├── gitlab_provider.py  # GitLab integration
│   ├── gitee_provider.py   # Gitee integration
│   └── interfaces/         # Repository interfaces
│
└── db/                     # Database configuration
    ├── session.py          # Database session
    └── base.py             # Base model
```

### Layered Architecture Pattern

```
┌─────────────────────────────────────┐
│  API Layer (endpoints/)             │
│  - Request validation               │
│  - Response formatting              │
│  - HTTP handling                    │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  Service Layer (services/)          │
│  - Business logic                   │
│  - Transaction management           │
│  - Cross-resource operations        │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  Repository Layer (repository/)     │
│  - External API integration         │
│  - Data transformation              │
└─────────────────────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  Database Layer (models/)           │
│  - ORM models                       │
│  - Database operations              │
└─────────────────────────────────────┘
```

### Key Backend Patterns

**1. Dependency Injection**
```python
from fastapi import Depends
from sqlalchemy.orm import Session
from app.api.dependencies import get_db, get_current_user

@router.get("/example")
def example(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # Function logic here
    pass
```

**2. Pydantic Schema Validation**
```python
from pydantic import BaseModel

class GhostSpec(BaseModel):
    systemPrompt: str
    mcpServers: Optional[Dict[str, Any]] = None
```

**3. Service Layer Pattern**
```python
# In services/ghost.py
class GhostService:
    def get_ghost(self, db: Session, name: str, namespace: str):
        # Business logic here
        pass
```

**4. Repository Pattern**
```python
# In repository/github_provider.py
class GitHubProvider:
    def get_repositories(self, token: str):
        # External API integration
        pass
```

---

## Core Concepts

Wegent is based on Kubernetes-style CRD (Custom Resource Definition) concepts.

### Resource Hierarchy

```
Ghost + Model + Shell
        ↓
       Bot
        ↓
      Team  ←──→  Workspace
        ↓            ↓
       Task ─────────┘
```

### Core Resources

**1. Ghost (Soul)**
- **Purpose**: Defines agent personality and capabilities
- **Contains**: System prompt, MCP server configurations
- **File**: `backend/app/models/ghost.py`
- **Schema**: `backend/app/schemas/kind.py` → `GhostSpec`

**2. Model (Brain)**
- **Purpose**: AI model configuration
- **Contains**: Environment variables, model parameters
- **File**: `backend/app/models/model.py`
- **Schema**: `backend/app/schemas/kind.py` → `ModelSpec`

**3. Shell (Runtime)**
- **Purpose**: Execution environment
- **Contains**: Runtime type (ClaudeCode, Agno), supported models
- **File**: `backend/app/models/shell.py`
- **Schema**: `backend/app/schemas/kind.py` → `ShellSpec`

**4. Bot (Complete Agent)**
- **Purpose**: Complete agent instance
- **Contains**: References to Ghost, Model, Shell
- **File**: `backend/app/models/bot.py`
- **Schema**: `backend/app/schemas/kind.py` → `BotSpec`

**5. Team (Collaboration)**
- **Purpose**: Group of Bots working together
- **Contains**: Team members, collaboration model
- **File**: `backend/app/models/team.py`
- **Schema**: `backend/app/schemas/kind.py` → `TeamSpec`

**6. Workspace (Environment)**
- **Purpose**: Work environment with repository
- **Contains**: Git repository information
- **File**: `backend/app/models/workspace.py`
- **Schema**: `backend/app/schemas/kind.py` → `WorkspaceSpec`

**7. Task (Work Unit)**
- **Purpose**: Executable work assigned to Team
- **Contains**: Title, prompt, team reference, workspace reference
- **File**: `backend/app/models/task.py`
- **Schema**: `backend/app/schemas/kind.py` → `TaskSpec`

### Collaboration Models

Teams can work in four collaboration patterns:

**1. Pipeline**
```
Bot A → Bot B → Bot C
```
Sequential execution, output feeds into next

**2. Route**
```
Leader Bot → {Bot A | Bot B | Bot C}
```
Leader assigns tasks to appropriate bot

**3. Coordinate**
```
Leader → [Bot A, Bot B, Bot C] → Leader
```
Leader coordinates parallel execution and aggregates

**4. Collaborate**
```
[Bot A ↔ Bot B ↔ Bot C]
```
Free discussion with shared context

---

## Data Flow Patterns

### 1. User Authentication Flow

```
Frontend                Backend                 Database
   │                       │                       │
   │──Login Request──────> │                       │
   │  (username/password)  │                       │
   │                       │──Query User────────>  │
   │                       │                       │
   │                       │<─User Data───────────│
   │                       │                       │
   │                       │──Verify Password      │
   │                       │──Create JWT Token     │
   │                       │                       │
   │<──JWT Token──────────│                       │
   │                       │                       │
```

### 2. Resource CRUD Flow

```
Frontend                Backend                 Database
   │                       │                       │
   │──POST /api/v1/ghosts─>│                       │
   │  (Ghost YAML)         │                       │
   │                       │──Validate Schema      │
   │                       │──Save to DB────────>  │
   │                       │                       │
   │                       │<──Confirmation───────│
   │                       │                       │
   │<──Response───────────│                       │
   │  (Ghost with status)  │                       │
   │                       │                       │
```

### 3. Task Execution Flow

```
Frontend → Backend → Executor Manager → Executor → Agent
   │          │            │                │         │
   │──Create  │            │                │         │
   │  Task ──>│            │                │         │
   │          │──Schedule─>│                │         │
   │          │  Task      │                │         │
   │          │            │──Create ──────>│         │
   │          │            │  Container     │         │
   │          │            │                │──Start─>│
   │          │            │                │  Agent  │
   │          │            │                │         │
   │          │            │<──Report Status│         │
   │          │<──Callback─│                │         │
   │<──Update │            │                │         │
   │  Status  │            │                │         │
```

### 4. WebSocket Real-Time Updates

```
Frontend                Backend                 Redis
   │                       │                       │
   │──WebSocket Connect──> │                       │
   │                       │                       │
   │                       │──Cache Status──────>  │
   │                       │                       │
   │                       │<──Status Update──────│
   │<──Push Update────────│                       │
   │                       │                       │
```

---

## Communication Between Layers

### Frontend ↔ Backend Communication

**1. REST API Calls**
```typescript
// In frontend/src/apis/ghosts.ts
export async function createGhost(ghost: Ghost): Promise<Ghost> {
  const response = await fetch('/api/v1/ghosts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(ghost)
  });
  return response.json();
}
```

**2. WebSocket for Real-Time Updates**
```typescript
// In frontend/src/hooks/useWebSocket.ts
const ws = new WebSocket('ws://localhost:8000/ws/tasks');
ws.onmessage = (event) => {
  const update = JSON.parse(event.data);
  updateTaskStatus(update);
};
```

### Backend Layer Communication

**1. API → Service**
```python
# In backend/app/api/endpoints/kind/kinds.py
@router.post("/ghosts")
def create_ghost(
    ghost: Ghost,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # Validate and delegate to service
    return ghost_service.create_ghost(db, ghost, current_user)
```

**2. Service → Database**
```python
# In backend/app/services/ghost.py
class GhostService:
    def create_ghost(self, db: Session, ghost: Ghost, user: User):
        # Business logic
        db_ghost = GhostModel(**ghost.dict())
        db.add(db_ghost)
        db.commit()
        return db_ghost
```

**3. Service → Repository**
```python
# In backend/app/services/workspace.py
class WorkspaceService:
    def get_repositories(self, token: str, provider: str):
        # Delegate to repository provider
        if provider == "github":
            return github_provider.get_repositories(token)
```

### Database Access Patterns

**1. Synchronous Operations**
```python
from sqlalchemy.orm import Session

def get_ghost(db: Session, name: str):
    return db.query(GhostModel).filter(
        GhostModel.name == name
    ).first()
```

**2. Asynchronous Operations**
```python
from sqlalchemy.ext.asyncio import AsyncSession

async def get_ghost_async(db: AsyncSession, name: str):
    result = await db.execute(
        select(GhostModel).filter(GhostModel.name == name)
    )
    return result.scalar_one_or_none()
```

### Cache Layer Integration

**1. Redis for Session Management**
```python
# In backend/app/core/cache.py
from redis import Redis

redis_client = Redis(host='localhost', port=6379, db=0)

def cache_task_status(task_id: str, status: dict):
    redis_client.setex(
        f"task:{task_id}",
        7200,  # 2-hour expiration
        json.dumps(status)
    )
```

**2. Cache Invalidation**
```python
def invalidate_task_cache(task_id: str):
    redis_client.delete(f"task:{task_id}")
```

---

## File Path Reference

### Frontend Key Files

| File | Purpose |
|------|---------|
| `/workspace/12738/Wegent/frontend/src/app/layout.tsx` | Root layout |
| `/workspace/12738/Wegent/frontend/src/components/ui/button.tsx` | Button component |
| `/workspace/12738/Wegent/frontend/src/apis/ghosts.ts` | Ghost API client |
| `/workspace/12738/Wegent/frontend/src/types/api.ts` | API type definitions |

### Backend Key Files

| File | Purpose |
|------|---------|
| `/workspace/12738/Wegent/backend/app/main.py` | Application entry |
| `/workspace/12738/Wegent/backend/app/core/security.py` | Authentication |
| `/workspace/12738/Wegent/backend/app/schemas/kind.py` | CRD schemas |
| `/workspace/12738/Wegent/backend/app/api/endpoints/auth.py` | Auth endpoints |
| `/workspace/12738/Wegent/backend/app/models/ghost.py` | Ghost model |

---

## Security Architecture

### Authentication and Authorization

**JWT Authentication**
- Location: `/workspace/12738/Wegent/backend/app/core/security.py`
- Token expiration: 7 days (configurable via `ACCESS_TOKEN_EXPIRE_MINUTES`)
- Algorithm: HS256
- Token includes: username, expiration timestamp

**OIDC Authentication**
- Location: `/workspace/12738/Wegent/backend/app/api/endpoints/oidc.py`
- Supports OAuth/OpenID Connect providers
- State token expiration: 10 minutes
- Callback handling for authentication flow

**Password Hashing**
- Algorithm: bcrypt
- Implementation: `passlib` library
- Functions: `get_password_hash()`, `verify_password()`

### Data Encryption

**AES Encryption for Share Tokens**
```python
# In backend/app/core/config.py
SHARE_TOKEN_AES_KEY: str = "32-byte key"
SHARE_TOKEN_AES_IV: str = "16-byte IV"
```

**Sensitive Data Protection**
- Git credentials encrypted with AES
- Environment variables for secrets
- No sensitive data in logs

### Container Isolation

- Docker containers for executor isolation
- Separate network namespace per executor
- Resource limits enforced
- Automatic cleanup after task completion

---

## Performance and Scalability

### Caching Strategy

**Redis Cache Configuration**
```python
# Task status caching
APPEND_CHAT_TASK_EXPIRE_HOURS = 2
APPEND_CODE_TASK_EXPIRE_HOURS = 24

# Repository caching
REPO_CACHE_EXPIRED_TIME = 7200  # 2 hours

# OIDC state caching
OIDC_STATE_EXPIRE_SECONDS = 600  # 10 minutes
```

**Cache Keys**
- Task status: `task:{task_id}`
- Repository info: `repo:{user_id}:{provider}`
- OIDC state: `oidc_state:{state_token}`

### Database Optimization

**Connection Pooling**
- SQLAlchemy connection pool
- Default pool size: 20 connections
- Overflow: 10 connections
- Pool recycle: 3600 seconds

**Query Optimization**
- Indexed columns: name, namespace, user_id, status
- Lazy loading for relationships
- Selective column loading where appropriate

### Horizontal Scaling

**Frontend Scaling**
- Stateless Next.js instances
- CDN for static assets
- Environment-based configuration

**Backend Scaling**
- Stateless FastAPI instances
- Redis for session sharing
- Load balancer compatible

**Executor Scaling**
```python
MAX_CONCURRENT_TASKS = 5  # Configurable
EXECUTOR_PORT_RANGE = (10001, 10100)  # 100 concurrent executors max
```

### Configuration Parameters

```python
# In backend/app/core/config.py
MAX_RUNNING_TASKS_PER_USER = 10
CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS = 2
CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS = 24
TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS = 600
```

---

## Related Documentation

- [Tech Stack](./tech-stack.md) - Complete technology reference
- [API Conventions](./api-conventions.md) - API design standards
- [Code Style](./code-style.md) - Coding standards
- [Design System](./design-system.md) - Frontend design system
- [Frontend Examples](./frontend-examples.md) - Frontend implementation examples
- [Backend Examples](./backend-examples.md) - Backend implementation examples
- [Testing Guide](./testing-guide.md) - Testing practices and standards

---

**Last Updated**: 2025-01-22
**Version**: 1.0.1
