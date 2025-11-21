# Code Style Guide

This document defines the coding standards and style conventions for the Wegent project. All AI agents must follow these guidelines to maintain code quality and consistency.

---

## Table of Contents

1. [Overview](#overview)
2. [Python/Backend Style](#pythonbackend-style)
3. [TypeScript/Frontend Style](#typescriptfrontend-style)
4. [Naming Conventions](#naming-conventions)
5. [Code Organization](#code-organization)
6. [Documentation Standards](#documentation-standards)
7. [Git Commit Guidelines](#git-commit-guidelines)

---

## Overview

### Tooling

**Backend (Python)**:
- **Formatter**: Black (line length: 100)
- **Linter**: Flake8
- **Type Checker**: mypy
- **Import Sorter**: isort

**Frontend (TypeScript)**:
- **Formatter**: Prettier
- **Linter**: ESLint
- **Type Checker**: TypeScript compiler

### Auto-formatting

**Backend**:
```bash
# Format code
black backend/app --line-length 100

# Sort imports
isort backend/app

# Check linting
flake8 backend/app
```

**Frontend**:
```bash
# Format code
npm run format

# Check linting
npm run lint

# Fix linting issues
npm run lint -- --fix
```

---

## Python/Backend Style

### General Principles

1. Follow **PEP 8** with modifications
2. Use **type hints** for all function parameters and return values
3. Keep functions **small and focused** (max 50 lines)
4. Use **meaningful variable names**
5. Write **docstrings** for all public functions and classes

### File Structure

**Location**: All Python files in `/workspace/12738/Wegent/backend/app/`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Module description.

This module provides functionality for...
"""

# Standard library imports
import os
import sys
from typing import Optional, List, Dict, Any
from datetime import datetime

# Third-party imports
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

# Local imports
from app.core.config import settings
from app.models.user import User
from app.services.kind import kind_service

# Constants
MAX_RETRY_COUNT = 3
DEFAULT_TIMEOUT = 30

# Type aliases
UserID = int
ResourceName = str

# Classes and functions follow...
```

### Type Hints

**Always use type hints**:

```python
# Good
def get_user(db: Session, user_id: int) -> Optional[User]:
    return db.query(User).filter(User.id == user_id).first()

def process_items(items: List[str], max_count: int = 10) -> Dict[str, Any]:
    result = {}
    for item in items[:max_count]:
        result[item] = len(item)
    return result

# Bad - missing type hints
def get_user(db, user_id):
    return db.query(User).filter(User.id == user_id).first()
```

### Function Definitions

**Use descriptive names and docstrings**:

```python
def create_ghost_resource(
    db: Session,
    ghost: Ghost,
    user_id: int,
    namespace: str = "default"
) -> GhostModel:
    """
    Create a new Ghost resource in the database.
    
    Args:
        db: Database session
        ghost: Ghost schema with specification
        user_id: ID of the user creating the resource
        namespace: Namespace for the resource (default: "default")
        
    Returns:
        GhostModel: Created Ghost database model
        
    Raises:
        ConflictException: If ghost with same name exists
        ValidationException: If ghost spec is invalid
    """
    # Check if ghost already exists
    existing = db.query(GhostModel).filter(
        GhostModel.name == ghost.metadata.name,
        GhostModel.namespace == namespace,
        GhostModel.user_id == user_id
    ).first()
    
    if existing:
        raise ConflictException(
            f"Ghost '{ghost.metadata.name}' already exists in namespace '{namespace}'"
        )
    
    # Create new ghost
    db_ghost = GhostModel(
        name=ghost.metadata.name,
        namespace=namespace,
        user_id=user_id,
        system_prompt=ghost.spec.systemPrompt,
        mcp_servers=ghost.spec.mcpServers
    )
    db.add(db_ghost)
    db.commit()
    db.refresh(db_ghost)
    
    return db_ghost
```

### Class Definitions

**Use Pydantic for data validation**:

```python
from pydantic import BaseModel, Field, validator
from typing import Optional, Dict, Any

class GhostSpec(BaseModel):
    """Ghost specification schema."""
    
    systemPrompt: str = Field(..., min_length=1, description="System prompt for the agent")
    mcpServers: Optional[Dict[str, Any]] = Field(
        default_factory=dict,
        description="MCP server configurations"
    )
    
    @validator('systemPrompt')
    def validate_system_prompt(cls, v: str) -> str:
        """Validate system prompt is not empty after stripping."""
        if not v.strip():
            raise ValueError("System prompt cannot be empty")
        return v.strip()
    
    class Config:
        schema_extra = {
            "example": {
                "systemPrompt": "You are a helpful developer assistant",
                "mcpServers": {
                    "github": {
                        "command": "docker",
                        "args": ["run", "-i", "ghcr.io/github/github-mcp-server"]
                    }
                }
            }
        }
```

### Error Handling

**Use custom exceptions**:

```python
from app.core.exceptions import NotFoundException, ConflictException

# Good - specific exceptions
try:
    ghost = kind_service.get_resource(db, "Ghost", name, namespace, user_id)
except NotFoundException:
    raise HTTPException(status_code=404, detail=f"Ghost '{name}' not found")
except ConflictException as e:
    raise HTTPException(status_code=409, detail=str(e))

# Bad - generic exceptions
try:
    ghost = kind_service.get_resource(db, "Ghost", name, namespace, user_id)
except Exception as e:
    raise HTTPException(status_code=500, detail="Something went wrong")
```

### Database Queries

**Use clear, readable queries**:

```python
# Good - clear and explicit
def get_user_ghosts(db: Session, user_id: int, namespace: str = "default") -> List[GhostModel]:
    """Get all ghosts for a user in a namespace."""
    return (
        db.query(GhostModel)
        .filter(
            GhostModel.user_id == user_id,
            GhostModel.namespace == namespace
        )
        .order_by(GhostModel.created_at.desc())
        .all()
    )

# Bad - complex one-liner
def get_user_ghosts(db, user_id, namespace="default"):
    return db.query(GhostModel).filter(GhostModel.user_id == user_id and GhostModel.namespace == namespace).all()
```

### Imports

**Use isort configuration**:

```python
# Standard library (alphabetical)
import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

# Third-party (alphabetical)
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

# Local (alphabetical by module)
from app.core.config import settings
from app.core.exceptions import NotFoundException
from app.models.ghost import Ghost as GhostModel
from app.schemas.kind import Ghost, GhostList
from app.services.kind import kind_service
```

---

## TypeScript/Frontend Style

### General Principles

1. Use **TypeScript** for all code (no plain JavaScript)
2. Enable **strict mode** in tsconfig.json
3. Use **functional components** with hooks
4. Prefer **const** over let, never use var
5. Use **async/await** instead of promises

### File Structure

**Location**: All TypeScript files in `/workspace/12738/Wegent/frontend/src/`

```typescript
// Component file structure
import React from 'react';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Third-party imports
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

// Local imports
import { Ghost } from '@/types/api';
import { listGhosts, createGhost } from '@/apis/ghosts';
import { formatDate } from '@/utils/format';

// Types/Interfaces
interface GhostListProps {
  userId: number;
  namespace?: string;
}

// Component
export function GhostList({ userId, namespace = 'default' }: GhostListProps) {
  // Component implementation
}
```

### Component Definition

**Use functional components with TypeScript**:

```typescript
import React, { useState, useEffect } from 'react';
import { Ghost } from '@/types/api';
import { listGhosts } from '@/apis/ghosts';

interface GhostListProps {
  namespace?: string;
  onGhostSelect?: (ghost: Ghost) => void;
}

export function GhostList({ namespace = 'default', onGhostSelect }: GhostListProps) {
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadGhosts() {
      try {
        setLoading(true);
        const data = await listGhosts();
        setGhosts(data.items);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load ghosts');
      } finally {
        setLoading(false);
      }
    }

    loadGhosts();
  }, [namespace]);

  if (loading) {
    return <div>Loading ghosts...</div>;
  }

  if (error) {
    return <div className="text-red-500">Error: {error}</div>;
  }

  return (
    <div className="space-y-4">
      {ghosts.map((ghost) => (
        <div
          key={`${ghost.metadata.namespace}/${ghost.metadata.name}`}
          className="p-4 border rounded cursor-pointer hover:bg-gray-50"
          onClick={() => onGhostSelect?.(ghost)}
        >
          <h3 className="font-semibold">{ghost.metadata.name}</h3>
          <p className="text-sm text-gray-600">{ghost.spec.systemPrompt}</p>
        </div>
      ))}
    </div>
  );
}
```

### Type Definitions

**Define interfaces for all data structures**:

```typescript
// Location: /workspace/12738/Wegent/frontend/src/types/api.ts

export interface Metadata {
  name: string;
  namespace: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GhostSpec {
  systemPrompt: string;
  mcpServers?: Record<string, any>;
}

export interface GhostStatus {
  state: 'Available' | 'Unavailable';
  message?: string;
}

export interface Ghost {
  apiVersion: string;
  kind: 'Ghost';
  metadata: Metadata;
  spec: GhostSpec;
  status?: GhostStatus;
}

export interface GhostList {
  apiVersion: string;
  kind: 'GhostList';
  items: Ghost[];
}

// Type guards
export function isGhost(obj: any): obj is Ghost {
  return (
    obj &&
    obj.apiVersion === 'agent.wecode.io/v1' &&
    obj.kind === 'Ghost' &&
    obj.metadata &&
    obj.spec
  );
}
```

### API Client Functions

**Use async/await with proper error handling**:

```typescript
// Location: /workspace/12738/Wegent/frontend/src/apis/ghosts.ts

import { Ghost, GhostList } from '@/types/api';

const API_BASE = '/api/v1';

class APIError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: any
  ) {
    super(message);
    this.name = 'APIError';
  }
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('auth_token');
  
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new APIError(error.detail || 'Request failed', response.status, error);
  }

  return response;
}

export async function listGhosts(): Promise<GhostList> {
  const response = await fetchWithAuth(`${API_BASE}/ghosts`);
  return response.json();
}

export async function getGhost(namespace: string, name: string): Promise<Ghost> {
  const response = await fetchWithAuth(`${API_BASE}/ghosts/${namespace}/${name}`);
  return response.json();
}

export async function createGhost(ghost: Ghost): Promise<Ghost> {
  const response = await fetchWithAuth(`${API_BASE}/ghosts`, {
    method: 'POST',
    body: JSON.stringify(ghost),
  });
  return response.json();
}

export async function updateGhost(
  namespace: string,
  name: string,
  ghost: Ghost
): Promise<Ghost> {
  const response = await fetchWithAuth(`${API_BASE}/ghosts/${namespace}/${name}`, {
    method: 'PUT',
    body: JSON.stringify(ghost),
  });
  return response.json();
}

export async function deleteGhost(namespace: string, name: string): Promise<void> {
  await fetchWithAuth(`${API_BASE}/ghosts/${namespace}/${name}`, {
    method: 'DELETE',
  });
}
```

### React Hooks

**Create custom hooks for reusable logic**:

```typescript
// Location: /workspace/12738/Wegent/frontend/src/hooks/useGhosts.ts

import { useState, useEffect, useCallback } from 'react';
import { Ghost, GhostList } from '@/types/api';
import { listGhosts, createGhost, updateGhost, deleteGhost } from '@/apis/ghosts';

interface UseGhostsReturn {
  ghosts: Ghost[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (ghost: Ghost) => Promise<Ghost>;
  update: (namespace: string, name: string, ghost: Ghost) => Promise<Ghost>;
  remove: (namespace: string, name: string) => Promise<void>;
}

export function useGhosts(): UseGhostsReturn {
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await listGhosts();
      setGhosts(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ghosts');
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(async (ghost: Ghost): Promise<Ghost> => {
    const created = await createGhost(ghost);
    await refresh();
    return created;
  }, [refresh]);

  const update = useCallback(
    async (namespace: string, name: string, ghost: Ghost): Promise<Ghost> => {
      const updated = await updateGhost(namespace, name, ghost);
      await refresh();
      return updated;
    },
    [refresh]
  );

  const remove = useCallback(
    async (namespace: string, name: string): Promise<void> => {
      await deleteGhost(namespace, name);
      await refresh();
    },
    [refresh]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ghosts, loading, error, refresh, create, update, remove };
}
```

---

## Naming Conventions

### Python Naming

| Type | Convention | Example |
|------|------------|---------|
| **Module** | snake_case | `user_service.py` |
| **Class** | PascalCase | `GhostService` |
| **Function** | snake_case | `get_user_ghosts()` |
| **Variable** | snake_case | `user_id` |
| **Constant** | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| **Private** | _leading_underscore | `_internal_method()` |
| **Type Alias** | PascalCase | `UserID = int` |

### TypeScript Naming

| Type | Convention | Example |
|------|------------|---------|
| **File** | kebab-case | `ghost-list.tsx` |
| **Component** | PascalCase | `GhostList` |
| **Function** | camelCase | `getUserGhosts()` |
| **Variable** | camelCase | `userId` |
| **Constant** | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| **Interface** | PascalCase | `GhostListProps` |
| **Type** | PascalCase | `UserID` |
| **Enum** | PascalCase | `ResourceState` |

### Database Naming

| Type | Convention | Example |
|------|------------|---------|
| **Table** | snake_case | `ghosts` |
| **Column** | snake_case | `user_id` |
| **Index** | ix_{table}_{column} | `ix_ghosts_name` |
| **Foreign Key** | fk_{table}_{column} | `fk_bots_ghost_id` |

---

## Code Organization

### Backend Layer Structure

```
backend/app/
├── api/                    # API layer (HTTP endpoints)
│   └── endpoints/
│       └── kind/
│           └── kinds.py    # Generic CRUD endpoints
├── services/               # Business logic layer
│   └── kind/
│       └── common.py       # Resource operations
├── repository/             # External API integration layer
│   └── github_provider.py
├── models/                 # Database models (SQLAlchemy)
│   └── ghost.py
└── schemas/                # Request/Response schemas (Pydantic)
    └── kind.py
```

**Separation of Concerns**:
- **API Layer**: HTTP handling, validation, formatting
- **Service Layer**: Business logic, transactions, orchestration
- **Repository Layer**: External API calls, data transformation
- **Model Layer**: Database schema, relationships
- **Schema Layer**: Data validation, serialization

### Frontend Feature Structure

```
frontend/src/features/
└── settings/
    ├── components/         # Feature-specific components
    │   ├── GhostForm.tsx
    │   └── GhostList.tsx
    ├── hooks/              # Feature-specific hooks
    │   └── useGhostForm.ts
    ├── utils/              # Feature-specific utilities
    │   └── validation.ts
    └── types/              # Feature-specific types
        └── ghost.ts
```

---

## Documentation Standards

### Python Docstrings

**Use Google-style docstrings**:

```python
def create_resource(
    db: Session,
    kind: str,
    resource: Dict[str, Any],
    user_id: int
) -> Any:
    """
    Create a new resource in the database.
    
    This function validates the resource specification, checks for conflicts,
    and creates a new database entry with the provided data.
    
    Args:
        db: SQLAlchemy database session
        kind: Resource type (Ghost, Bot, Team, etc.)
        resource: Resource specification dictionary
        user_id: ID of the user creating the resource
        
    Returns:
        Created database model instance
        
    Raises:
        ConflictException: If resource with same name already exists
        ValidationException: If resource specification is invalid
        
    Example:
        >>> ghost_spec = {
        ...     "metadata": {"name": "dev-ghost", "namespace": "default"},
        ...     "spec": {"systemPrompt": "You are a developer"}
        ... }
        >>> ghost = create_resource(db, "Ghost", ghost_spec, user_id=1)
    """
    # Implementation
```

### TypeScript JSDoc Comments

```typescript
/**
 * Fetch all ghosts for the current user.
 * 
 * @returns Promise resolving to list of ghosts
 * @throws {APIError} If authentication fails or request errors
 * 
 * @example
 * ```typescript
 * const ghosts = await listGhosts();
 * console.log(ghosts.items);
 * ```
 */
export async function listGhosts(): Promise<GhostList> {
  // Implementation
}
```

### Inline Comments

```python
# Good - explain WHY, not WHAT
# Use exponential backoff to avoid overwhelming the API
retry_delay = 2 ** attempt

# Bad - redundant comment
# Set retry_delay to 2 raised to the power of attempt
retry_delay = 2 ** attempt
```

---

## Git Commit Guidelines

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, no logic change)
- **refactor**: Code refactoring
- **test**: Adding or updating tests
- **chore**: Maintenance tasks

### Examples

```
feat(api): add Ghost resource CRUD endpoints

Implement complete CRUD operations for Ghost resources following
Kubernetes-style API conventions. Includes validation, error handling,
and proper status codes.

Closes #123
```

```
fix(frontend): resolve Ghost list infinite loading

Fixed issue where Ghost list would show loading state indefinitely
when API returns empty array. Added proper empty state handling.

Fixes #456
```

```
refactor(backend): extract common validation logic

Moved resource validation to common module to reduce code duplication
across different resource types. No functional changes.
```

### Commit Best Practices

1. **Keep commits atomic** - one logical change per commit
2. **Write descriptive messages** - explain why, not what
3. **Reference issues** - use "Closes #123" or "Fixes #456"
4. **Test before committing** - ensure code works
5. **Follow conventional commits** - enable automated changelog generation

---

## Related Documentation

- [Architecture](./architecture.md) - System architecture
- [API Conventions](./api-conventions.md) - API design standards
- [Testing Guide](./testing-guide.md) - Testing practices
- [Backend Examples](./backend-examples.md) - Implementation examples
- [Frontend Examples](./frontend-examples.md) - Implementation examples

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
