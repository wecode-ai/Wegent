# Testing Guide

This document provides comprehensive testing practices and standards for the Wegent project. All AI agents must follow these guidelines when writing and running tests.

---

## Table of Contents

1. [Overview](#overview)
2. [Testing Framework](#testing-framework)
3. [Backend Testing (pytest)](#backend-testing-pytest)
4. [Frontend Testing (Jest)](#frontend-testing-jest)
5. [Test Coverage Requirements](#test-coverage-requirements)
6. [Testing Patterns](#testing-patterns)
7. [CI/CD Integration](#cicd-integration)

---

## Overview

### Testing Philosophy

- **Write tests first** (TDD when possible)
- **Test behavior, not implementation**
- **Keep tests simple and focused**
- **Use descriptive test names**
- **Mock external dependencies**
- **Maintain high coverage** (80%+ target)

### Test Types

| Type | Purpose | Location |
|------|---------|----------|
| **Unit** | Test individual functions/methods | `tests/` |
| **Integration** | Test component interactions | `tests/` |
| **API** | Test HTTP endpoints | `tests/api/` |
| **E2E** | Test complete workflows | `tests/e2e/` |

---

## Testing Framework

### Backend (Python)

**Framework**: pytest 7.4.0+

**Key Libraries**:
- `pytest-asyncio` - Async test support
- `pytest-cov` - Coverage reporting
- `pytest-mock` - Mocking utilities
- `pytest-httpx` - HTTP client testing

**Configuration**: `/workspace/12738/Wegent/backend/pytest.ini`

```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts = 
    -v
    --cov=app
    --cov-report=html
    --cov-report=term-missing
    --asyncio-mode=auto
markers =
    unit: Unit tests
    integration: Integration tests
    api: API endpoint tests
    slow: Slow running tests
```

### Frontend (TypeScript)

**Framework**: Jest 29.7.0

**Key Libraries**:
- `@testing-library/react` - React component testing
- `@testing-library/jest-dom` - DOM matchers
- `@testing-library/user-event` - User interaction simulation
- `msw` - API mocking

**Configuration**: `/workspace/12738/Wegent/frontend/jest.config.js`

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.stories.tsx',
    '!src/app/**',  // Exclude Next.js app directory
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 80,
      statements: 80,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
```

---

## Backend Testing (pytest)

### Test File Structure

```
backend/tests/
├── conftest.py             # Shared fixtures
├── core/
│   ├── test_security.py    # Security tests
│   ├── test_config.py      # Configuration tests
│   └── test_exceptions.py  # Exception handling tests
├── services/
│   ├── test_user_service.py
│   └── test_kind_service.py
├── repository/
│   └── test_github_provider.py
├── models/
│   └── test_user_model.py
└── api/
    └── endpoints/
        └── test_ghosts.py
```

### Fixtures

**Location**: `/workspace/12738/Wegent/backend/tests/conftest.py`

```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from app.main import app
from app.db.base import Base
from app.models.user import User
from app.core.security import get_password_hash, create_access_token

# Database fixtures
@pytest.fixture(scope="function")
def test_db():
    """Create a test database session."""
    # Use in-memory SQLite for tests
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)

# User fixtures
@pytest.fixture
def test_user(test_db):
    """Create a test user."""
    user = User(
        user_name="testuser",
        email="test@example.com",
        hashed_password=get_password_hash("testpassword123"),
        is_active=True,
        is_admin=False
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user

@pytest.fixture
def test_admin_user(test_db):
    """Create a test admin user."""
    admin = User(
        user_name="admin",
        email="admin@example.com",
        hashed_password=get_password_hash("admin123"),
        is_active=True,
        is_admin=True
    )
    test_db.add(admin)
    test_db.commit()
    test_db.refresh(admin)
    return admin

@pytest.fixture
def test_token(test_user):
    """Generate a test JWT token."""
    return create_access_token({"sub": test_user.user_name})

# API client fixture
@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)
```

### Unit Test Example

**Location**: `/workspace/12738/Wegent/backend/tests/core/test_security.py`

```python
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
    """Test password hashing and verification."""

    def test_get_password_hash_creates_valid_hash(self):
        """Test that get_password_hash creates a valid bcrypt hash."""
        password = "testpassword123"
        hashed = get_password_hash(password)

        assert hashed is not None
        assert hashed != password
        assert hashed.startswith("$2b$")  # bcrypt hash prefix

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

@pytest.mark.unit
class TestTokenOperations:
    """Test JWT token creation and verification."""

    def test_create_access_token_with_default_expiration(self):
        """Test creating access token with default expiration."""
        data = {"sub": "testuser"}
        token = create_access_token(data)

        assert token is not None
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        assert payload["sub"] == "testuser"
        assert "exp" in payload

    def test_verify_token_with_valid_token(self):
        """Test verifying a valid token."""
        data = {"sub": "testuser"}
        token = create_access_token(data)
        result = verify_token(token)
        
        assert result["username"] == "testuser"

    def test_verify_token_with_invalid_token(self):
        """Test verifying an invalid token raises HTTPException."""
        with pytest.raises(HTTPException) as exc_info:
            verify_token("invalid.token.here")
        
        assert exc_info.value.status_code == 401
```

### Integration Test Example

**Location**: `/workspace/12738/Wegent/backend/tests/api/endpoints/test_ghosts.py`

```python
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.ghost import Ghost as GhostModel

@pytest.mark.integration
class TestGhostEndpoints:
    """Test Ghost API endpoints."""

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
            "metadata": {
                "name": "test-ghost",
                "namespace": "default"
            },
            "spec": {
                "systemPrompt": "You are a test assistant",
                "mcpServers": {}
            }
        }
        
        response = client.post(
            "/api/v1/ghosts",
            json=ghost_data,
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["metadata"]["name"] == "test-ghost"
        assert data["spec"]["systemPrompt"] == "You are a test assistant"
        assert "createdAt" in data["metadata"]

    def test_create_duplicate_ghost_fails(self, client, test_token, test_db, test_user):
        """Test creating duplicate ghost returns conflict error."""
        # Create first ghost
        ghost = GhostModel(
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
            "metadata": {
                "name": "existing-ghost",
                "namespace": "default"
            },
            "spec": {
                "systemPrompt": "Test",
                "mcpServers": {}
            }
        }
        
        response = client.post(
            "/api/v1/ghosts",
            json=ghost_data,
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 409
        assert "already exists" in response.json()["detail"]

    def test_get_ghost_success(self, client, test_token, test_db, test_user):
        """Test getting a specific ghost."""
        # Create ghost
        ghost = GhostModel(
            name="test-ghost",
            namespace="default",
            user_id=test_user.id,
            system_prompt="Test prompt",
            mcp_servers={}
        )
        test_db.add(ghost)
        test_db.commit()
        
        response = client.get(
            "/api/v1/ghosts/default/test-ghost",
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["metadata"]["name"] == "test-ghost"
        assert data["spec"]["systemPrompt"] == "Test prompt"

    def test_get_nonexistent_ghost_returns_404(self, client, test_token):
        """Test getting nonexistent ghost returns 404."""
        response = client.get(
            "/api/v1/ghosts/default/nonexistent",
            headers={"Authorization": f"Bearer {test_token}"}
        )
        
        assert response.status_code == 404
        assert "not found" in response.json()["detail"]

    def test_unauthorized_request_returns_401(self, client):
        """Test request without token returns 401."""
        response = client.get("/api/v1/ghosts")
        assert response.status_code == 401
```

### Mocking Example

```python
import pytest
from unittest.mock import Mock, patch

@pytest.mark.unit
def test_github_provider_with_mock(mocker):
    """Test GitHub provider with mocked HTTP client."""
    # Mock the HTTP response
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = [
        {"id": 1, "name": "repo1", "full_name": "user/repo1"},
        {"id": 2, "name": "repo2", "full_name": "user/repo2"}
    ]
    
    # Mock requests.get
    mocker.patch("requests.get", return_value=mock_response)
    
    from app.repository.github_provider import GitHubProvider
    
    provider = GitHubProvider()
    repos = provider.get_repositories("fake-token")
    
    assert len(repos) == 2
    assert repos[0]["name"] == "repo1"
```

### Running Tests

```bash
# Run all tests
cd /workspace/12738/Wegent/backend
pytest

# Run specific test file
pytest tests/core/test_security.py

# Run specific test class
pytest tests/core/test_security.py::TestPasswordHashing

# Run specific test
pytest tests/core/test_security.py::TestPasswordHashing::test_get_password_hash_creates_valid_hash

# Run with coverage
pytest --cov=app --cov-report=html

# Run only unit tests
pytest -m unit

# Run excluding slow tests
pytest -m "not slow"

# Run with verbose output
pytest -v

# Run with output capture disabled
pytest -s
```

---

## Frontend Testing (Jest)

### Test File Structure

```
frontend/src/
├── components/
│   └── ui/
│       ├── button.tsx
│       └── button.test.tsx
├── features/
│   └── settings/
│       ├── components/
│       │   ├── GhostForm.tsx
│       │   └── GhostForm.test.tsx
│       └── utils/
│           ├── validation.ts
│           └── __tests__/
│               └── validation.test.ts
└── apis/
    ├── ghosts.ts
    └── ghosts.test.ts
```

### Component Test Example

```typescript
// Location: /workspace/12738/Wegent/frontend/src/components/ui/button.test.tsx

import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './button';

describe('Button', () => {
  it('renders with children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('handles click events', () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    
    fireEvent.click(screen.getByText('Click me'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('can be disabled', () => {
    const handleClick = jest.fn();
    render(<Button disabled onClick={handleClick}>Click me</Button>);
    
    const button = screen.getByText('Click me');
    expect(button).toBeDisabled();
    
    fireEvent.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('applies variant classes', () => {
    const { container } = render(<Button variant="destructive">Delete</Button>);
    const button = container.querySelector('button');
    
    expect(button).toHaveClass('bg-destructive');
  });
});
```

### Hook Test Example

```typescript
// Location: /workspace/12738/Wegent/frontend/src/hooks/__tests__/useGhosts.test.ts

import { renderHook, waitFor } from '@testing-library/react';
import { useGhosts } from '../useGhosts';
import * as ghostsApi from '@/apis/ghosts';

// Mock the API
jest.mock('@/apis/ghosts');

describe('useGhosts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads ghosts on mount', async () => {
    const mockGhosts = {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'GhostList',
      items: [
        {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Ghost',
          metadata: { name: 'test-ghost', namespace: 'default' },
          spec: { systemPrompt: 'Test' }
        }
      ]
    };

    (ghostsApi.listGhosts as jest.Mock).mockResolvedValue(mockGhosts);

    const { result } = renderHook(() => useGhosts());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.ghosts).toHaveLength(1);
    expect(result.current.ghosts[0].metadata.name).toBe('test-ghost');
  });

  it('handles error when loading fails', async () => {
    (ghostsApi.listGhosts as jest.Mock).mockRejectedValue(
      new Error('Network error')
    );

    const { result } = renderHook(() => useGhosts());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.ghosts).toHaveLength(0);
  });
});
```

### API Mock with MSW

```typescript
// Location: /workspace/12738/Wegent/frontend/src/mocks/handlers.ts

import { rest } from 'msw';

export const handlers = [
  rest.get('/api/v1/ghosts', (req, res, ctx) => {
    return res(
      ctx.status(200),
      ctx.json({
        apiVersion: 'agent.wecode.io/v1',
        kind: 'GhostList',
        items: [
          {
            apiVersion: 'agent.wecode.io/v1',
            kind: 'Ghost',
            metadata: {
              name: 'test-ghost',
              namespace: 'default'
            },
            spec: {
              systemPrompt: 'You are a test assistant'
            }
          }
        ]
      })
    );
  }),

  rest.post('/api/v1/ghosts', (req, res, ctx) => {
    const ghost = req.body as any;
    return res(
      ctx.status(201),
      ctx.json({
        ...ghost,
        metadata: {
          ...ghost.metadata,
          createdAt: new Date().toISOString()
        }
      })
    );
  }),
];

// Location: /workspace/12738/Wegent/frontend/src/mocks/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

### Running Tests

```bash
# Run all tests
cd /workspace/12738/Wegent/frontend
npm test

# Run in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- button.test.tsx

# Run tests matching pattern
npm test -- --testNamePattern="renders with children"
```

---

## Test Coverage Requirements

### Minimum Coverage Targets

| Component | Line Coverage | Branch Coverage |
|-----------|--------------|-----------------|
| **Backend** | 80% | 70% |
| **Frontend** | 80% | 70% |
| **Core Utilities** | 90% | 80% |
| **API Endpoints** | 85% | 75% |

### Generating Coverage Reports

**Backend**:
```bash
cd /workspace/12738/Wegent/backend
pytest --cov=app --cov-report=html --cov-report=term-missing

# View HTML report
open htmlcov/index.html
```

**Frontend**:
```bash
cd /workspace/12738/Wegent/frontend
npm run test:coverage

# View HTML report
open coverage/lcov-report/index.html
```

---

## Testing Patterns

### AAA Pattern (Arrange-Act-Assert)

```python
def test_create_ghost():
    # Arrange
    db = create_test_db()
    user = create_test_user(db)
    ghost_data = {
        "name": "test-ghost",
        "system_prompt": "Test"
    }
    
    # Act
    result = create_ghost(db, ghost_data, user.id)
    
    # Assert
    assert result.name == "test-ghost"
    assert result.user_id == user.id
```

### Parameterized Tests

```python
import pytest

@pytest.mark.parametrize("input,expected", [
    ("test-ghost", True),
    ("Test Ghost", False),  # Uppercase not allowed
    ("test_ghost", True),
    ("test@ghost", False),  # Special chars not allowed
])
def test_validate_resource_name(input, expected):
    assert validate_resource_name(input) == expected
```

### Snapshot Testing (Frontend)

```typescript
import { render } from '@testing-library/react';
import { GhostCard } from './GhostCard';

it('matches snapshot', () => {
  const ghost = {
    metadata: { name: 'test-ghost', namespace: 'default' },
    spec: { systemPrompt: 'Test' }
  };
  
  const { container } = render(<GhostCard ghost={ghost} />);
  expect(container).toMatchSnapshot();
});
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  backend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-python@v2
        with:
          python-version: '3.9'
      - name: Install dependencies
        run: |
          cd backend
          pip install -r requirements.txt
          pip install pytest pytest-cov
      - name: Run tests
        run: |
          cd backend
          pytest --cov=app --cov-report=xml
      - name: Upload coverage
        uses: codecov/codecov-action@v2

  frontend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - name: Install dependencies
        run: |
          cd frontend
          npm ci
      - name: Run tests
        run: |
          cd frontend
          npm run test:coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v2
```

---

## Related Documentation

- [Code Style](./code-style.md) - Coding standards
- [Backend Examples](./backend-examples.md) - Backend implementation examples
- [Testing Examples](./testing-examples.md) - Comprehensive testing examples
- [API Conventions](./api-conventions.md) - API design standards

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
