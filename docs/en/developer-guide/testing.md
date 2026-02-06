# Test Framework Documentation

This document describes the unit testing framework setup for the Wegent project.

## Overview

The project includes comprehensive unit testing support across all modules:

- **Backend** (FastAPI): pytest + pytest-asyncio + pytest-cov + pytest-mock
- **Executor** (AI Agent Engine): pytest + pytest-mock + pytest-asyncio
- **Executor Manager** (Task Management): pytest + pytest-mock + pytest-cov
- **Shared** (Utilities): pytest + pytest-cov
- **Frontend** (Next.js + React 19): Jest + @testing-library/react

## Current Test Coverage

### Backend (`backend/`)
- ✅ Core security: Authentication, JWT tokens, password hashing
- ✅ Configuration management
- ✅ Exception handling
- ✅ User service and models
- ✅ GitHub repository provider
- ⏳ API endpoints (placeholder directory exists)

### Executor (`executor/`)
- ✅ Agent factory
- ✅ Base agent classes
- ✅ Mocked AI client interactions (Anthropic, OpenAI)

### Executor Manager (`executor_manager/`)
- ✅ Base executor classes
- ✅ Task dispatcher
- ✅ Docker executor and utilities
- ✅ Docker constants and configuration

### Shared (`shared/`)
- ✅ Cryptography utilities
- ✅ Sensitive data masking (tokens, API keys, etc.)

### Frontend (`frontend/`)
- ⏳ Component tests (basic setup in place)
- ⏳ Hook tests
- ⏳ Utility tests

## Test Coverage Goals

- **Target**: 40-60% code coverage initially
- **Priority**: Core business logic and critical paths
- **Strategy**: Incremental coverage improvement

## Backend Tests

### Running Tests

```bash
cd backend
pytest                          # Run all tests
pytest tests/core/             # Run core tests only
pytest --cov=app               # Run with coverage report
pytest -v                      # Verbose output
pytest -k test_security        # Run specific test pattern
pytest -m unit                 # Run only unit tests
pytest -m integration          # Run only integration tests
```

### Test Structure

```
backend/tests/
├── conftest.py              # Global test fixtures
├── core/                    # Core infrastructure tests
│   ├── test_security.py     # Authentication & JWT tests
│   ├── test_config.py       # Configuration tests
│   └── test_exceptions.py   # Exception handler tests
├── services/                # Service layer tests
│   └── test_user_service.py # User service tests
├── models/                  # Data model tests
│   └── test_user_model.py   # User model tests
├── repository/              # Repository integration tests
│   └── test_github_provider.py
└── api/                     # API endpoint tests (placeholder)
```

### Test Configuration

The backend uses `pytest.ini` for configuration with the following settings:

```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts =
    -v
    --strict-markers
    --cov=app
    --cov-report=term-missing
    --cov-report=html
    --cov-report=xml
asyncio_mode = auto
markers =
    unit: Unit tests
    integration: Integration tests
    slow: Slow running tests
```

### Key Fixtures

- `test_db`: SQLite in-memory database session (function scope)
- `test_settings`: Test settings with overridden values
- `test_user`: Test user instance
- `test_admin_user`: Test admin user instance
- `test_inactive_user`: Inactive test user instance
- `test_token`: Valid JWT token for test user
- `test_admin_token`: Valid JWT token for admin user
- `test_client`: FastAPI test client with database override
- `mock_redis`: Mocked Redis client

## Executor Tests

### Running Tests

```bash
cd executor
pytest tests/ --cov=agents
```

### Test Structure

```
executor/tests/
├── conftest.py              # Executor-specific fixtures
└── agents/                  # Agent tests
```

### Key Fixtures

- `mock_anthropic_client`: Mocked Anthropic API client for testing Claude models
- `mock_openai_client`: Mocked OpenAI API client for testing GPT models
- `mock_callback_client`: Mocked callback HTTP client for agent responses
- `suppress_resource_warnings`: Session-scoped fixture to suppress ResourceWarning messages
- `cleanup_logging`: Session-scoped fixture to clean up logging handlers and prevent daemon thread errors

## Executor Manager Tests

### Running Tests

```bash
cd executor_manager
pytest tests/ --cov=executors
```

### Key Fixtures

- `mock_docker_client`: Mocked Docker SDK client for container operations
- `mock_executor_config`: Mock executor configuration with image, CPU, memory, and network settings

### Test Structure

```
executor_manager/tests/
├── conftest.py              # Executor manager fixtures
└── executors/               # Executor tests
    ├── test_base.py
    ├── test_dispatcher.py
    ├── test_docker_executor.py
    ├── test_docker_utils.py
    └── test_docker_constants.py
```

## Shared Tests

### Running Tests

```bash
cd shared
pytest tests/ --cov=utils
```

### Test Structure

```
shared/tests/
└── utils/
    ├── test_crypto.py               # Encryption/decryption tests
    └── test_sensitive_data_masker.py # Sensitive data masking tests
```

### Key Features Tested

- **Cryptography**: Encryption and decryption of sensitive data (Git tokens, API keys)
- **Data Masking**: Automatic masking of sensitive information in logs and outputs
  - GitHub tokens (github_pat_*)
  - Anthropic API keys (sk-ant-api03-*)
  - OpenAI API keys
  - Generic API keys and secrets
  - File path protection (no false positives)
  - URL protection (no false positives)

## Frontend Tests

### Running Tests

```bash
cd frontend
npm test                     # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
```

### Test Structure

```
frontend/src/__tests__/
├── utils/                   # Utility function tests
├── hooks/                   # React hooks tests
└── components/              # Component tests
```

## Continuous Integration

### GitHub Actions Workflow

The `.github/workflows/test.yml` workflow runs automatically on:
- Push to `main`, `master`, or `develop` branches
- Pull requests to these branches

### Workflow Jobs

1. **test-backend**: Python backend tests
   - Matrix strategy: Python 3.10 and 3.11
   - Coverage reports uploaded to Codecov
   - Dependency caching for faster builds

2. **test-executor**: Executor engine tests
   - Python 3.10
   - Coverage for agents module
   - Tests AI agent factory and base classes

3. **test-executor-manager**: Task manager tests
   - Python 3.10
   - Coverage for executors module
   - Tests Docker executor and dispatcher

4. **test-shared**: Shared utilities tests
   - Python 3.10
   - Coverage for utils module
   - Tests cryptography and data masking

5. **test-frontend**: Frontend tests (Node.js 18.x)
   - Jest with React Testing Library
   - Runs with `--passWithNoTests` flag
   - Coverage uploaded to Codecov

6. **test-summary**: Aggregate results
   - Depends on all test jobs
   - Fails if any test job fails
   - Always runs regardless of individual job status

### Coverage Reports

Coverage reports are automatically uploaded to Codecov (if configured).

## Mocking Strategy

### External APIs

- **GitHub/GitLab/Gitee**: Mock with `httpx-mock` or `pytest-mock`
- **Anthropic/OpenAI**: Mock SDK clients
- **Redis**: Use `fakeredis` or mock

### Database

- **Test DB**: SQLite in-memory database
- **Isolation**: Each test gets a fresh transaction
- **Cleanup**: Automatic rollback after each test

### Docker

- Mock `docker.from_env()` and container operations

## Best Practices

### Writing Tests

1. **One assertion per test**: Each test should verify one specific behavior
2. **Descriptive names**: Use clear, descriptive test function names that explain what is being tested
3. **AAA pattern**: Arrange, Act, Assert - structure your tests clearly
4. **Mock external dependencies**: Never call real external services (APIs, databases, etc.)
5. **Use fixtures**: Share common test setup via fixtures to reduce duplication
6. **Test edge cases**: Include tests for error conditions, boundary values, and unusual inputs
7. **Keep tests independent**: Each test should be able to run independently without relying on other tests

### Security Testing Best Practices

The project includes comprehensive security testing examples in `backend/tests/core/test_security.py`:

- Password hashing and verification (bcrypt)
- JWT token creation and validation
- Token expiration handling
- User authentication with valid/invalid credentials
- Inactive user detection
- Role-based access control (admin vs regular users)

Example test pattern for security features:

```python
@pytest.mark.unit
class TestPasswordHashing:
    """Test password hashing and verification functions"""

    def test_verify_password_with_correct_password(self):
        """Test password verification with correct password"""
        password = "testpassword123"
        hashed = get_password_hash(password)
        assert verify_password(password, hashed) is True

    def test_verify_password_with_incorrect_password(self):
        """Test password verification with incorrect password"""
        password = "testpassword123"
        hashed = get_password_hash(password)
        assert verify_password("wrongpassword", hashed) is False
```

### Test Organization

```python
@pytest.mark.unit
class TestFeatureName:
    """Test feature description"""

    def test_success_case(self):
        """Test successful operation"""
        # Arrange
        data = {"key": "value"}

        # Act
        result = function_under_test(data)

        # Assert
        assert result == expected_value

    def test_error_case(self):
        """Test error handling"""
        with pytest.raises(ExpectedException):
            function_under_test(invalid_data)
```

### Using Test Markers

Test markers help categorize and selectively run tests:

```bash
# Run only unit tests
pytest -m unit

# Run only integration tests
pytest -m integration

# Run slow tests
pytest -m slow

# Skip slow tests
pytest -m "not slow"
```

### Async Tests

```python
@pytest.mark.asyncio
async def test_async_function():
    """Test asynchronous function"""
    result = await async_function()
    assert result is not None
```

The backend's `pytest.ini` has `asyncio_mode = auto` which automatically detects and runs async tests.

## Adding New Tests

### Backend

1. Create test file in appropriate `tests/` subdirectory (e.g., `tests/services/test_new_service.py`)
2. Import necessary fixtures from `conftest.py`
3. Use `@pytest.mark.unit` or `@pytest.mark.integration` to categorize tests
4. Follow the AAA (Arrange-Act-Assert) pattern
5. Write test classes and methods with descriptive names
6. Run tests locally before committing: `pytest tests/ -v`
7. Ensure coverage is maintained or improved: `pytest --cov=app --cov-report=term-missing`

### Frontend

1. Create test file in `src/__tests__/` matching source structure
2. Use `@testing-library/react` for component tests
3. Mock API calls and external dependencies
4. Ensure tests pass with `npm test`

## Debugging Tests

### Backend

```bash
# Run specific test with verbose output
pytest tests/core/test_security.py::TestPasswordHashing::test_verify_password_with_correct_password -v

# Drop into debugger on failure
pytest --pdb

# Show print statements
pytest -s
```

### Frontend

```bash
# Run tests in watch mode
npm run test:watch

# Debug specific test file
npm test -- src/__tests__/utils/test_example.test.ts
```

## Configuration Files

### Backend

- `backend/pytest.ini`: pytest configuration with coverage settings and test markers
  - Enables verbose output, strict markers, and automatic async mode
  - Configures coverage reports in terminal, HTML, and XML formats
  - Defines custom markers: `unit`, `integration`, `slow`

### Executor/Executor Manager/Shared

- `pytest.ini`: Module-specific pytest configuration
- Similar setup to backend but with module-specific coverage targets

### Frontend

- `frontend/jest.config.ts`: Jest configuration
- `frontend/jest.setup.js`: Test environment setup

## Future Improvements

- [ ] Increase coverage to 70-80%
- [ ] Add integration tests for API endpoints (currently placeholder)
- [ ] Add E2E tests for critical user flows
- [ ] Performance/load testing
- [ ] Mutation testing with `mutmut`
- [ ] Add more frontend component tests
- [ ] Implement database migration tests
- [ ] Add tests for WebSocket connections and real-time features

## Troubleshooting

### Common Issues

**Import errors in tests:**
- Ensure you're running pytest from the correct directory
- Check that modules are installed: `uv sync`

**Database errors:**
- Tests use SQLite in-memory DB, no setup needed
- Check that fixtures are imported correctly

**Frontend test failures:**
- Ensure Node.js 18.x is installed
- Run `npm ci` to install exact dependency versions
- Clear Jest cache: `npx jest --clearCache`

## Resources

- [pytest documentation](https://docs.pytest.org/)
- [Testing Library](https://testing-library.com/)
- [Jest documentation](https://jestjs.io/)
- [GitHub Actions](https://docs.github.com/en/actions)
