# API Conventions

This document defines the API design standards and conventions for the Wegent platform. All AI agents must follow these guidelines when implementing or modifying API endpoints.

---

## Table of Contents

1. [Overview](#overview)
2. [RESTful API Design](#restful-api-design)
3. [Kubernetes-Style Resource API](#kubernetes-style-resource-api)
4. [Authentication and Authorization](#authentication-and-authorization)
5. [Request and Response Formats](#request-and-response-formats)
6. [Error Handling](#error-handling)
7. [Versioning](#versioning)
8. [Code Examples](#code-examples)

---

## Overview

Wegent's API follows two complementary design patterns:

1. **RESTful API** for standard operations
2. **Kubernetes-style declarative API** for resource management

**Base URL**: `/api/v1`

**Content Type**: `application/json`

**Authentication**: JWT Bearer Token

---

## RESTful API Design

### HTTP Methods

| Method | Purpose | Idempotent | Safe |
|--------|---------|------------|------|
| **GET** | Retrieve resources | Yes | Yes |
| **POST** | Create resources | No | No |
| **PUT** | Update/replace resources | Yes | No |
| **PATCH** | Partial update | No | No |
| **DELETE** | Delete resources | Yes | No |

### URL Structure

**Pattern**: `/api/v1/{resource-type}/{namespace}/{name}`

**Examples**:
```
GET    /api/v1/ghosts                    # List all ghosts
GET    /api/v1/ghosts/default/dev-ghost  # Get specific ghost
POST   /api/v1/ghosts                    # Create new ghost
PUT    /api/v1/ghosts/default/dev-ghost  # Update ghost
DELETE /api/v1/ghosts/default/dev-ghost  # Delete ghost
```

### Status Codes

| Code | Meaning | When to Use |
|------|---------|-------------|
| **200** | OK | Successful GET, PUT, DELETE |
| **201** | Created | Successful POST |
| **204** | No Content | Successful DELETE with no body |
| **400** | Bad Request | Invalid input data |
| **401** | Unauthorized | Missing or invalid auth |
| **403** | Forbidden | Insufficient permissions |
| **404** | Not Found | Resource doesn't exist |
| **409** | Conflict | Resource already exists |
| **422** | Unprocessable Entity | Validation error |
| **500** | Internal Server Error | Server-side error |

---

## Kubernetes-Style Resource API

### Resource Structure

All resources follow the Kubernetes CRD format:

```yaml
apiVersion: agent.wecode.io/v1
kind: {ResourceType}
metadata:
  name: {resource-name}
  namespace: {namespace}
  createdAt: {timestamp}
  updatedAt: {timestamp}
spec:
  # Resource specification (desired state)
status:
  state: {Available|Unavailable}
  # Additional status information
```

### Resource Types

| Kind | Plural | Purpose |
|------|--------|---------|
| Ghost | ghosts | Agent personality definition |
| Model | models | AI model configuration |
| Shell | shells | Runtime environment |
| Bot | bots | Complete agent instance |
| Team | teams | Bot collaboration group |
| Workspace | workspaces | Code repository environment |
| Task | tasks | Executable work unit |

### Metadata Fields

**Required**:
- `name`: Resource identifier (unique within namespace)
- `namespace`: Logical grouping (default: "default")

**Auto-generated**:
- `createdAt`: ISO 8601 timestamp
- `updatedAt`: ISO 8601 timestamp

### Spec and Status Separation

**Spec**: Desired state (user-defined)
```yaml
spec:
  systemPrompt: "You are a developer..."
  mcpServers: {...}
```

**Status**: Actual state (system-managed)
```yaml
status:
  state: "Available"
  message: "Ready to use"
```

---

## Authentication and Authorization

### JWT Authentication

**Header Format**:
```
Authorization: Bearer {jwt-token}
```

**Token Structure**:
```json
{
  "sub": "username",
  "exp": 1234567890
}
```

**Implementation Example**:
```python
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer
from app.core.security import verify_token

security = HTTPBearer()

def get_current_user(token: str = Depends(security)):
    credentials = verify_token(token.credentials)
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials"
        )
    return credentials["username"]
```

### OIDC Authentication

**Login Flow**:
1. GET `/api/auth/oidc/login` - Initiate OIDC flow
2. User authenticates with provider
3. GET `/api/auth/oidc/callback?code={code}&state={state}` - Callback
4. Receive JWT token

**Endpoints**:
```python
# Location: /workspace/12738/Wegent/backend/app/api/endpoints/oidc.py

@router.get("/oidc/login")
def oidc_login():
    # Generate state, redirect to OIDC provider
    pass

@router.get("/oidc/callback")
def oidc_callback(code: str, state: str):
    # Exchange code for token, return JWT
    pass
```

### Authorization Levels

**User**: Access own resources
```python
@router.get("/ghosts")
def list_ghosts(current_user: User = Depends(get_current_user)):
    # Returns only user's ghosts
    pass
```

**Admin**: Access all users' resources
```python
@router.get("/admin/users/{user_id}/ghosts")
def list_user_ghosts(
    user_id: int,
    admin: User = Depends(get_admin_user)
):
    # Returns specified user's ghosts
    pass
```

---

## Request and Response Formats

### List Resources

**Request**:
```http
GET /api/v1/ghosts HTTP/1.1
Authorization: Bearer {token}
```

**Response**:
```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "GhostList",
  "items": [
    {
      "apiVersion": "agent.wecode.io/v1",
      "kind": "Ghost",
      "metadata": {
        "name": "developer-ghost",
        "namespace": "default",
        "createdAt": "2025-01-22T10:00:00Z",
        "updatedAt": "2025-01-22T10:00:00Z"
      },
      "spec": {
        "systemPrompt": "You are a developer...",
        "mcpServers": {}
      },
      "status": {
        "state": "Available"
      }
    }
  ]
}
```

### Get Single Resource

**Request**:
```http
GET /api/v1/ghosts/default/developer-ghost HTTP/1.1
Authorization: Bearer {token}
```

**Response**:
```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Ghost",
  "metadata": {
    "name": "developer-ghost",
    "namespace": "default",
    "createdAt": "2025-01-22T10:00:00Z",
    "updatedAt": "2025-01-22T10:00:00Z"
  },
  "spec": {
    "systemPrompt": "You are a developer...",
    "mcpServers": {}
  },
  "status": {
    "state": "Available"
  }
}
```

### Create Resource

**Request**:
```http
POST /api/v1/ghosts HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Ghost",
  "metadata": {
    "name": "new-ghost",
    "namespace": "default"
  },
  "spec": {
    "systemPrompt": "You are a helpful assistant",
    "mcpServers": {}
  }
}
```

**Response**: `201 Created`
```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Ghost",
  "metadata": {
    "name": "new-ghost",
    "namespace": "default",
    "createdAt": "2025-01-22T10:30:00Z",
    "updatedAt": "2025-01-22T10:30:00Z"
  },
  "spec": {
    "systemPrompt": "You are a helpful assistant",
    "mcpServers": {}
  },
  "status": {
    "state": "Available"
  }
}
```

### Update Resource

**Request**:
```http
PUT /api/v1/ghosts/default/new-ghost HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Ghost",
  "metadata": {
    "name": "new-ghost",
    "namespace": "default"
  },
  "spec": {
    "systemPrompt": "Updated prompt",
    "mcpServers": {}
  }
}
```

**Response**: `200 OK` (updated resource)

### Delete Resource

**Request**:
```http
DELETE /api/v1/ghosts/default/new-ghost HTTP/1.1
Authorization: Bearer {token}
```

**Response**: `200 OK`
```json
{
  "message": "Ghost 'new-ghost' deleted successfully"
}
```

---

## Error Handling

### Error Response Format

```json
{
  "detail": "Error message",
  "status_code": 404,
  "error_type": "not_found"
}
```

### Common Error Scenarios

**404 Not Found**:
```json
{
  "detail": "Ghost 'nonexistent' not found in namespace 'default'",
  "status_code": 404
}
```

**409 Conflict**:
```json
{
  "detail": "Ghost 'developer-ghost' already exists in namespace 'default'",
  "status_code": 409
}
```

**400 Bad Request**:
```json
{
  "detail": [
    {
      "loc": ["body", "spec", "systemPrompt"],
      "msg": "field required",
      "type": "value_error.missing"
    }
  ],
  "status_code": 400
}
```

**401 Unauthorized**:
```json
{
  "detail": "Could not validate credentials",
  "status_code": 401
}
```

**403 Forbidden**:
```json
{
  "detail": "Permission denied. Admin access required.",
  "status_code": 403
}
```

### Exception Handler Implementation

**Location**: `/workspace/12738/Wegent/backend/app/core/exceptions.py`

```python
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

class CustomHTTPException(HTTPException):
    pass

class NotFoundException(CustomHTTPException):
    def __init__(self, detail: str):
        super().__init__(status_code=404, detail=detail)

class ConflictException(CustomHTTPException):
    def __init__(self, detail: str):
        super().__init__(status_code=409, detail=detail)

async def http_exception_handler(request: Request, exc: CustomHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.detail,
            "status_code": exc.status_code
        }
    )
```

---

## Versioning

### API Version

Current version: **v1**

Base path: `/api/v1`

### Resource API Version

All resources use: `agent.wecode.io/v1`

```yaml
apiVersion: agent.wecode.io/v1  # Always specify this version
```

### Version Migration

When introducing breaking changes:
1. Create new version: `/api/v2`
2. Maintain v1 for backward compatibility
3. Document migration path
4. Deprecate old version with notice period

---

## Code Examples

### Backend: Creating a New Endpoint

**Location**: `/workspace/12738/Wegent/backend/app/api/endpoints/kind/kinds.py`

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Any

from app.api.dependencies import get_db, get_current_user
from app.models.user import User
from app.schemas.kind import Ghost, GhostList
from app.services.kind import kind_service
from app.core.exceptions import NotFoundException, ConflictException

router = APIRouter()

@router.get("/ghosts", response_model=GhostList)
def list_ghosts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """
    List all ghosts for the current user.
    """
    ghosts = kind_service.list_resources(
        db=db,
        kind="Ghost",
        namespace="default",
        user_id=current_user.id
    )
    return format_resource_list("Ghost", ghosts)

@router.get("/ghosts/{namespace}/{name}", response_model=Ghost)
def get_ghost(
    namespace: str,
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """
    Get a specific ghost by name and namespace.
    """
    try:
        ghost = kind_service.get_resource(
            db=db,
            kind="Ghost",
            name=name,
            namespace=namespace,
            user_id=current_user.id
        )
        return format_single_resource("Ghost", ghost)
    except NotFoundException as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.post("/ghosts", response_model=Ghost, status_code=status.HTTP_201_CREATED)
def create_ghost(
    resource: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """
    Create a new ghost.
    """
    try:
        # Validate and prepare resource
        validated = validate_and_prepare_resource(
            kind="Ghost",
            resource=resource,
            namespace=resource.get("metadata", {}).get("namespace", "default")
        )
        
        # Create resource
        ghost = kind_service.create_resource(
            db=db,
            kind="Ghost",
            resource=validated,
            user_id=current_user.id
        )
        return format_single_resource("Ghost", ghost)
    except ConflictException as e:
        raise HTTPException(status_code=409, detail=str(e))

@router.put("/ghosts/{namespace}/{name}", response_model=Ghost)
def update_ghost(
    namespace: str,
    name: str,
    resource: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """
    Update an existing ghost.
    """
    try:
        # Validate and prepare resource
        validated = validate_and_prepare_resource(
            kind="Ghost",
            resource=resource,
            namespace=namespace,
            name=name
        )
        
        # Update resource
        ghost = kind_service.update_resource(
            db=db,
            kind="Ghost",
            name=name,
            namespace=namespace,
            resource=validated,
            user_id=current_user.id
        )
        return format_single_resource("Ghost", ghost)
    except NotFoundException as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.delete("/ghosts/{namespace}/{name}")
def delete_ghost(
    namespace: str,
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
) -> Any:
    """
    Delete a ghost.
    """
    try:
        kind_service.delete_resource(
            db=db,
            kind="Ghost",
            name=name,
            namespace=namespace,
            user_id=current_user.id
        )
        return {"message": f"Ghost '{name}' deleted successfully"}
    except NotFoundException as e:
        raise HTTPException(status_code=404, detail=str(e))
```

### Frontend: API Client Function

**Location**: `/workspace/12738/Wegent/frontend/src/apis/ghosts.ts`

```typescript
const API_BASE = '/api/v1';

export interface Ghost {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    createdAt?: string;
    updatedAt?: string;
  };
  spec: {
    systemPrompt: string;
    mcpServers?: Record<string, any>;
  };
  status?: {
    state: string;
  };
}

export interface GhostList {
  apiVersion: string;
  kind: string;
  items: Ghost[];
}

// Get auth token from storage
function getAuthToken(): string | null {
  return localStorage.getItem('auth_token');
}

// List all ghosts
export async function listGhosts(): Promise<GhostList> {
  const response = await fetch(`${API_BASE}/ghosts`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${getAuthToken()}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to list ghosts: ${response.statusText}`);
  }

  return response.json();
}

// Get single ghost
export async function getGhost(namespace: string, name: string): Promise<Ghost> {
  const response = await fetch(`${API_BASE}/ghosts/${namespace}/${name}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${getAuthToken()}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Ghost '${name}' not found in namespace '${namespace}'`);
    }
    throw new Error(`Failed to get ghost: ${response.statusText}`);
  }

  return response.json();
}

// Create ghost
export async function createGhost(ghost: Ghost): Promise<Ghost> {
  const response = await fetch(`${API_BASE}/ghosts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getAuthToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ghost)
  });

  if (!response.ok) {
    if (response.status === 409) {
      throw new Error('Ghost with this name already exists');
    }
    throw new Error(`Failed to create ghost: ${response.statusText}`);
  }

  return response.json();
}

// Update ghost
export async function updateGhost(
  namespace: string,
  name: string,
  ghost: Ghost
): Promise<Ghost> {
  const response = await fetch(`${API_BASE}/ghosts/${namespace}/${name}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${getAuthToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ghost)
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Ghost '${name}' not found`);
    }
    throw new Error(`Failed to update ghost: ${response.statusText}`);
  }

  return response.json();
}

// Delete ghost
export async function deleteGhost(namespace: string, name: string): Promise<void> {
  const response = await fetch(`${API_BASE}/ghosts/${namespace}/${name}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${getAuthToken()}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Ghost '${name}' not found`);
    }
    throw new Error(`Failed to delete ghost: ${response.statusText}`);
  }
}
```

### Request Validation with Pydantic

**Location**: `/workspace/12738/Wegent/backend/app/schemas/kind.py`

```python
from pydantic import BaseModel, Field, validator
from typing import Optional, Dict, Any
from datetime import datetime

class Metadata(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    namespace: str = Field(default="default", min_length=1, max_length=255)
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None

    @validator('name')
    def validate_name(cls, v):
        # Name must be lowercase alphanumeric with hyphens
        if not v.replace('-', '').replace('_', '').isalnum():
            raise ValueError('Name must contain only alphanumeric characters, hyphens, and underscores')
        return v

class GhostSpec(BaseModel):
    systemPrompt: str = Field(..., min_length=1)
    mcpServers: Optional[Dict[str, Any]] = Field(default_factory=dict)

class GhostStatus(BaseModel):
    state: str = Field(default="Available")
    message: Optional[str] = None

class Ghost(BaseModel):
    apiVersion: str = Field(default="agent.wecode.io/v1")
    kind: str = Field(default="Ghost")
    metadata: Metadata
    spec: GhostSpec
    status: Optional[GhostStatus] = None

    class Config:
        schema_extra = {
            "example": {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Ghost",
                "metadata": {
                    "name": "developer-ghost",
                    "namespace": "default"
                },
                "spec": {
                    "systemPrompt": "You are a professional developer",
                    "mcpServers": {}
                },
                "status": {
                    "state": "Available"
                }
            }
        }

class GhostList(BaseModel):
    apiVersion: str = Field(default="agent.wecode.io/v1")
    kind: str = Field(default="GhostList")
    items: list[Ghost]
```

---

## Related Documentation

- [Architecture](./architecture.md) - System architecture overview
- [Code Style](./code-style.md) - Coding standards
- [Backend Examples](./backend-examples.md) - Backend implementation examples
- [Frontend Examples](./frontend-examples.md) - Frontend implementation examples
- [Testing Guide](./testing-guide.md) - Testing practices

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
