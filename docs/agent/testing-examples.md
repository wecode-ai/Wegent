# Testing Examples

This document provides comprehensive testing examples for the Wegent project, covering unit tests, integration tests, API tests, and end-to-end tests.

---

## Table of Contents

1. [Example 1: Unit Testing Security Functions](#example-1-unit-testing-security-functions)
2. [Example 2: Integration Testing API Endpoints](#example-2-integration-testing-api-endpoints)
3. [Example 3: Frontend Component Testing](#example-3-frontend-component-testing)
4. [Example 4: Testing Database Models and Relationships](#example-4-testing-database-models-and-relationships)
5. [Example 5: End-to-End Workflow Testing](#example-5-end-to-end-workflow-testing)

---

## Example 1: Unit Testing Security Functions

### Objective

Write comprehensive unit tests for password hashing and JWT token functions.

### Prerequisites

- pytest installed and configured
- Understanding of security functions
- Knowledge of test fixtures

### Step-by-Step Instructions

**Step 1: Create Test File**

File: `/workspace/12738/Wegent/backend/tests/core/test_security.py`

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from datetime import datetime, timedelta
from jose import jwt
from fastapi import HTTPException

from app.core.security import (
    verify_password,
    get_password_hash,
    create_access_token,
    verify_token,
)
from app.core.config import settings

@pytest.mark.unit
class TestPasswordHashing:
    """Test password hashing functions."""

    def test_hash_password_creates_valid_hash(self):
        """Test that hashing creates a valid bcrypt hash."""
        password = "testpassword123"
        hashed = get_password_hash(password)

        assert hashed is not None
        assert hashed != password
        assert hashed.startswith("$2b$")

    def test_verify_password_with_correct_password(self):
        """Test password verification with correct password."""
        password = "testpassword123"
        hashed = get_password_hash(password)

        assert verify_password(password, hashed) is True

    def test_verify_password_with_incorrect_password(self):
        """Test password verification with incorrect password."""
        password = "testpassword123"
        hashed = get_password_hash(password)

        assert verify_password("wrongpassword", hashed) is False

    @pytest.mark.parametrize("password,expected", [
        ("", False),
        ("short", True),
        ("very_long_password_with_special_chars!@#$%", True),
    ])
    def test_verify_password_edge_cases(self, password, expected):
        """Test password verification with edge cases."""
        if password:
            hashed = get_password_hash(password)
            assert verify_password(password, hashed) is expected
        else:
            hashed = get_password_hash("test")
            assert verify_password(password, hashed) is False

@pytest.mark.unit
class TestJWTTokens:
    """Test JWT token operations."""

    def test_create_token_with_default_expiration(self):
        """Test creating token with default expiration."""
        data = {"sub": "testuser"}
        token = create_access_token(data)

        assert token is not None
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        assert payload["sub"] == "testuser"
        assert "exp" in payload

    def test_create_token_with_custom_expiration(self):
        """Test creating token with custom expiration."""
        data = {"sub": "testuser"}
        expires_delta = 60  # 60 minutes
        token = create_access_token(data, expires_delta=expires_delta)

        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        assert payload["sub"] == "testuser"

    def test_verify_valid_token(self):
        """Test verifying a valid token."""
        data = {"sub": "testuser"}
        token = create_access_token(data)
        result = verify_token(token)

        assert result["username"] == "testuser"

    def test_verify_invalid_token(self):
        """Test verifying an invalid token raises exception."""
        with pytest.raises(HTTPException) as exc_info:
            verify_token("invalid.token.here")

        assert exc_info.value.status_code == 401

    def test_verify_expired_token(self):
        """Test verifying an expired token raises exception."""
        data = {"sub": "testuser"}
        expired_data = data.copy()
        expired_data["exp"] = (datetime.now() - timedelta(minutes=1)).timestamp()
        expired_token = jwt.encode(
            expired_data,
            settings.SECRET_KEY,
            algorithm=settings.ALGORITHM
        )

        with pytest.raises(HTTPException) as exc_info:
            verify_token(expired_token)

        assert exc_info.value.status_code == 401
```

**Step 2: Run Tests**

```bash
cd /workspace/12738/Wegent/backend
pytest tests/core/test_security.py -v
```

### Validation

1. All tests pass
2. Coverage report shows 100% for security functions
3. Edge cases are handled correctly

### Common Pitfalls

- Not testing edge cases
- Hardcoding values instead of using settings
- Not using parametrize for multiple similar tests

---

## Example 2: Integration Testing API Endpoints

### Objective

Write integration tests for Ghost CRUD API endpoints with database interaction.

### Prerequisites

- Test database configured
- Understanding of FastAPI TestClient
- Knowledge of fixtures

### Step-by-Step Instructions

**Step 1: Create Test Fixtures**

File: `/workspace/12738/Wegent/backend/tests/conftest.py`

```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from app.main import app
from app.db.base import Base
from app.models.user import User
from app.models.ghost import Ghost
from app.core.security import get_password_hash, create_access_token

@pytest.fixture(scope="function")
def test_db():
    """Create test database."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)

@pytest.fixture
def test_user(test_db):
    """Create test user."""
    user = User(
        user_name="testuser",
        email="test@example.com",
        hashed_password=get_password_hash("testpassword123"),
        is_active=True
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user

@pytest.fixture
def test_token(test_user):
    """Generate test JWT token."""
    return create_access_token({"sub": test_user.user_name})

@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)
```

**Step 2: Write Integration Tests**

File: `/workspace/12738/Wegent/backend/tests/api/test_ghosts.py`

```python
import pytest

@pytest.mark.integration
class TestGhostEndpoints:
    """Integration tests for Ghost API endpoints."""

    def test_list_ghosts_empty(self, client, test_token):
        """Test listing ghosts when none exist."""
        response = client.get(
            "/api/v1/ghosts",
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["kind"] == "GhostList"
        assert len(data["items"]) == 0

    def test_create_ghost_success(self, client, test_token):
        """Test successful ghost creation."""
        ghost_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "test-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "Test", "mcpServers": {}}
        }
        
        response = client.post(
            "/api/v1/ghosts",
            json=ghost_data,
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["metadata"]["name"] == "test-ghost"
        assert "createdAt" in data["metadata"]

    def test_create_duplicate_ghost_fails(self, client, test_token, test_db, test_user):
        """Test creating duplicate ghost fails."""
        from app.models.ghost import Ghost
        
        # Create first ghost
        ghost = Ghost(
            name="existing-ghost",
            namespace="default",
            user_id=test_user.id,
            system_prompt="Test",
            mcp_servers={}
        )
        test_db.add(ghost)
        test_db.commit()
        
        # Try to create duplicate
        ghost_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "existing-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "Test", "mcpServers": {}}
        }
        
        response = client.post(
            "/api/v1/ghosts",
            json=ghost_data,
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 409

    def test_get_ghost_success(self, client, test_token, test_db, test_user):
        """Test getting a specific ghost."""
        from app.models.ghost import Ghost
        
        ghost = Ghost(
            name="test-ghost",
            namespace="default",
            user_id=test_user.id,
            system_prompt="Test",
            mcp_servers={}
        )
        test_db.add(ghost)
        test_db.commit()
        
        response = client.get(
            "/api/v1/ghosts/default/test-ghost",
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 200
        assert response.json()["metadata"]["name"] == "test-ghost"

    def test_update_ghost_success(self, client, test_token, test_db, test_user):
        """Test updating a ghost."""
        from app.models.ghost import Ghost
        
        ghost = Ghost(
            name="test-ghost",
            namespace="default",
            user_id=test_user.id,
            system_prompt="Original",
            mcp_servers={}
        )
        test_db.add(ghost)
        test_db.commit()
        
        update_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "test-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "Updated", "mcpServers": {}}
        }
        
        response = client.put(
            "/api/v1/ghosts/default/test-ghost",
            json=update_data,
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 200
        assert response.json()["spec"]["systemPrompt"] == "Updated"

    def test_delete_ghost_success(self, client, test_token, test_db, test_user):
        """Test deleting a ghost."""
        from app.models.ghost import Ghost
        
        ghost = Ghost(
            name="test-ghost",
            namespace="default",
            user_id=test_user.id,
            system_prompt="Test",
            mcp_servers={}
        )
        test_db.add(ghost)
        test_db.commit()
        
        response = client.delete(
            "/api/v1/ghosts/default/test-ghost",
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 200
        
        # Verify ghost is deleted
        verify_response = client.get(
            "/api/v1/ghosts/default/test-ghost",
            headers={"Authorization": f"Bearer {test_token}"}
        )
        assert verify_response.status_code == 404
```

**Step 3: Run Tests**

```bash
pytest tests/api/test_ghosts.py -v
```

### Validation

1. All CRUD operations tested
2. Error cases handled
3. Database state verified
4. Authentication tested

### Common Pitfalls

- Not using test database
- Not cleaning up after tests
- Missing authentication headers
- Not verifying database state

---

## Example 3: Frontend Component Testing

### Objective

Write comprehensive tests for a React component using Testing Library.

### Prerequisites

- Jest configured
- Testing Library installed
- Understanding of React hooks

### Step-by-Step Instructions

**Step 1: Create Component Test**

File: `/workspace/12738/Wegent/frontend/src/components/ghosts/__tests__/GhostList.test.tsx`

```typescript
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GhostList } from '../GhostList';
import * as ghostsApi from '@/apis/ghosts';

// Mock API
jest.mock('@/apis/ghosts');

describe('GhostList', () => {
  const mockGhosts = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'GhostList',
    items: [
      {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Ghost',
        metadata: { name: 'ghost-1', namespace: 'default' },
        spec: { systemPrompt: 'Test prompt 1', mcpServers: {} }
      },
      {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Ghost',
        metadata: { name: 'ghost-2', namespace: 'default' },
        spec: { systemPrompt: 'Test prompt 2', mcpServers: {} }
      }
    ]
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders loading state initially', () => {
    (ghostsApi.listGhosts as jest.Mock).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<GhostList />);
    expect(screen.getByText('Loading ghosts...')).toBeInTheDocument();
  });

  it('renders ghost list after loading', async () => {
    (ghostsApi.listGhosts as jest.Mock).mockResolvedValue(mockGhosts);

    render(<GhostList />);

    await waitFor(() => {
      expect(screen.getByText('ghost-1')).toBeInTheDocument();
      expect(screen.getByText('ghost-2')).toBeInTheDocument();
    });
  });

  it('filters ghosts by name', async () => {
    (ghostsApi.listGhosts as jest.Mock).mockResolvedValue(mockGhosts);

    render(<GhostList />);

    await waitFor(() => {
      expect(screen.getByText('ghost-1')).toBeInTheDocument();
    });

    const filterInput = screen.getByPlaceholderText('Filter ghosts...');
    fireEvent.change(filterInput, { target: { value: 'ghost-1' } });

    expect(screen.getByText('ghost-1')).toBeInTheDocument();
    expect(screen.queryByText('ghost-2')).not.toBeInTheDocument();
  });

  it('calls onSelect when ghost is clicked', async () => {
    (ghostsApi.listGhosts as jest.Mock).mockResolvedValue(mockGhosts);
    const onSelect = jest.fn();

    render(<GhostList onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByText('ghost-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('ghost-1'));
    expect(onSelect).toHaveBeenCalledWith(mockGhosts.items[0]);
  });

  it('displays error message on API failure', async () => {
    (ghostsApi.listGhosts as jest.Mock).mockRejectedValue(
      new Error('Network error')
    );

    render(<GhostList />);

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when no ghosts exist', async () => {
    (ghostsApi.listGhosts as jest.Mock).mockResolvedValue({
      ...mockGhosts,
      items: []
    });

    render(<GhostList />);

    await waitFor(() => {
      expect(screen.getByText('No ghosts found')).toBeInTheDocument();
    });
  });
});
```

**Step 2: Run Tests**

```bash
cd /workspace/12738/Wegent/frontend
npm test GhostList.test.tsx
```

### Validation

1. All tests pass
2. Loading, success, and error states tested
3. User interactions tested
4. Edge cases covered

### Common Pitfalls

- Not waiting for async updates
- Not mocking API calls
- Not testing error states
- Missing cleanup between tests

---

## Example 4: Testing Database Models and Relationships

### Objective

Test database models, relationships, and cascade delete behavior.

### Prerequisites

- Understanding of SQLAlchemy
- Knowledge of database relationships
- Test database configured

### Step-by-Step Instructions

**Step 1: Create Model Tests**

File: `/workspace/12738/Wegent/backend/tests/models/test_team_model.py`

```python
import pytest
from app.models.team import Team
from app.models.bot import Bot
from app.models.ghost import Ghost
from app.models.user import User

@pytest.mark.unit
class TestTeamModel:
    """Test Team model and relationships."""

    def test_create_team(self, test_db, test_user):
        """Test creating a team."""
        team = Team(
            name="test-team",
            namespace="default",
            user_id=test_user.id,
            collaboration_model="pipeline"
        )
        test_db.add(team)
        test_db.commit()
        
        assert team.id is not None
        assert team.name == "test-team"

    def test_team_user_relationship(self, test_db, test_user):
        """Test team-user relationship."""
        team = Team(
            name="test-team",
            namespace="default",
            user_id=test_user.id,
            collaboration_model="pipeline"
        )
        test_db.add(team)
        test_db.commit()
        test_db.refresh(team)
        
        assert team.user.id == test_user.id
        assert team.user.user_name == test_user.user_name

    def test_team_members_relationship(self, test_db, test_user):
        """Test team-bot many-to-many relationship."""
        # Create ghost and bot
        ghost = Ghost(
            name="test-ghost",
            namespace="default",
            user_id=test_user.id,
            system_prompt="Test"
        )
        test_db.add(ghost)
        test_db.commit()
        
        bot = Bot(
            name="test-bot",
            namespace="default",
            user_id=test_user.id,
            ghost_id=ghost.id
        )
        test_db.add(bot)
        test_db.commit()
        
        # Create team
        team = Team(
            name="test-team",
            namespace="default",
            user_id=test_user.id,
            collaboration_model="pipeline"
        )
        test_db.add(team)
        test_db.commit()
        
        # Add bot to team
        team.members.append(bot)
        test_db.commit()
        test_db.refresh(team)
        
        assert len(team.members) == 1
        assert team.members[0].id == bot.id

    def test_cascade_delete(self, test_db, test_user):
        """Test cascade delete removes team members."""
        # Setup
        ghost = Ghost(
            name="test-ghost",
            namespace="default",
            user_id=test_user.id,
            system_prompt="Test"
        )
        test_db.add(ghost)
        test_db.commit()
        
        bot = Bot(
            name="test-bot",
            namespace="default",
            user_id=test_user.id,
            ghost_id=ghost.id
        )
        test_db.add(bot)
        test_db.commit()
        
        team = Team(
            name="test-team",
            namespace="default",
            user_id=test_user.id,
            collaboration_model="pipeline"
        )
        test_db.add(team)
        test_db.commit()
        
        team.members.append(bot)
        test_db.commit()
        
        team_id = team.id
        
        # Delete team
        test_db.delete(team)
        test_db.commit()
        
        # Verify bot still exists but not in team
        bot_exists = test_db.query(Bot).filter(Bot.id == bot.id).first()
        assert bot_exists is not None
```

**Step 2: Run Tests**

```bash
pytest tests/models/test_team_model.py -v
```

### Validation

1. Model creation works
2. Relationships function correctly
3. Cascade behavior verified
4. Constraints enforced

### Common Pitfalls

- Not committing transactions
- Not refreshing objects after commit
- Missing relationship configurations
- Not testing cascade behavior

---

## Example 5: End-to-End Workflow Testing

### Objective

Test complete workflow from user login to task creation and execution.

### Prerequisites

- Understanding of E2E testing
- Knowledge of async operations
- Test infrastructure configured

### Step-by-Step Instructions

**Step 1: Create E2E Test**

File: `/workspace/12738/Wegent/backend/tests/e2e/test_task_workflow.py`

```python
import pytest
from fastapi.testclient import TestClient
from app.main import app

@pytest.mark.e2e
class TestTaskWorkflow:
    """End-to-end workflow tests."""

    def test_complete_task_workflow(self, client, test_db):
        """Test complete workflow from login to task execution."""
        # 1. Register user
        register_data = {
            "username": "testuser",
            "email": "test@example.com",
            "password": "testpassword123"
        }
        response = client.post("/api/auth/register", json=register_data)
        assert response.status_code == 201
        
        # 2. Login
        login_data = {
            "username": "testuser",
            "password": "testpassword123"
        }
        response = client.post("/api/auth/login", json=login_data)
        assert response.status_code == 200
        token = response.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # 3. Create Ghost
        ghost_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "dev-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "You are a developer", "mcpServers": {}}
        }
        response = client.post("/api/v1/ghosts", json=ghost_data, headers=headers)
        assert response.status_code == 201
        
        # 4. Create Bot
        bot_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "dev-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "dev-ghost", "namespace": "default"},
                "modelRef": {"name": "default-model", "namespace": "default"},
                "shellRef": {"name": "default-shell", "namespace": "default"}
            }
        }
        response = client.post("/api/v1/bots", json=bot_data, headers=headers)
        assert response.status_code == 201
        
        # 5. Create Team
        team_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "dev-team", "namespace": "default"},
            "spec": {
                "members": [{
                    "name": "developer",
                    "botRef": {"name": "dev-bot", "namespace": "default"},
                    "role": "leader"
                }],
                "collaborationModel": "pipeline"
            }
        }
        response = client.post("/api/v1/teams", json=team_data, headers=headers)
        assert response.status_code == 201
        
        # 6. Create Workspace
        workspace_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Workspace",
            "metadata": {"name": "test-workspace", "namespace": "default"},
            "spec": {
                "repository": {
                    "gitUrl": "https://github.com/test/repo.git",
                    "branchName": "main"
                }
            }
        }
        response = client.post("/api/v1/workspaces", json=workspace_data, headers=headers)
        assert response.status_code == 201
        
        # 7. Create Task
        task_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "test-task", "namespace": "default"},
            "spec": {
                "title": "Test task",
                "prompt": "Write a hello world function",
                "teamRef": {"name": "dev-team", "namespace": "default"},
                "workspaceRef": {"name": "test-workspace", "namespace": "default"}
            }
        }
        response = client.post("/api/v1/tasks", json=task_data, headers=headers)
        assert response.status_code == 201
        task = response.json()
        
        # 8. Verify task created
        response = client.get(
            f"/api/v1/tasks/default/{task['metadata']['name']}",
            headers=headers
        )
        assert response.status_code == 200
        assert response.json()["spec"]["title"] == "Test task"
```

**Step 2: Run E2E Tests**

```bash
pytest tests/e2e/ -v -m e2e
```

### Validation

1. Complete workflow executes successfully
2. All resources created correctly
3. Relationships established
4. Authentication works throughout

### Common Pitfalls

- Not cleaning up test data
- Race conditions in async operations
- Hardcoded IDs or names
- Missing dependency setup

---

## Related Documentation

- [Testing Guide](./testing-guide.md) - Testing practices
- [Code Style](./code-style.md) - Coding standards
- [Backend Examples](./backend-examples.md) - Implementation examples
- [Frontend Examples](./frontend-examples.md) - Component examples

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
