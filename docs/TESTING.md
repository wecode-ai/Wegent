# Test Framework Documentation

This document describes the unit testing framework setup for the Wegent project.

## Overview

The project now includes comprehensive unit testing support across all modules:

- **Backend** (FastAPI): pytest + pytest-asyncio + pytest-cov
- **Executor** (AI Agent Engine): pytest + pytest-mock
- **Executor Manager** (Task Management): pytest + pytest-mock
- **Shared** (Utilities): pytest
- **Frontend** (Next.js + React 19): Jest + @testing-library/react

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
└── api/                     # API endpoint tests
```

### Key Fixtures

- `test_db`: SQLite in-memory database session
- `test_user`: Test user instance
- `test_admin_user`: Test admin user
- `test_token`: Valid JWT token
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

- `mock_anthropic_client`: Mocked Anthropic API client
- `mock_openai_client`: Mocked OpenAI API client
- `mock_callback_client`: Mocked callback HTTP client

## Executor Manager Tests

### Running Tests

```bash
cd executor_manager
pytest tests/ --cov=executors
```

### Key Fixtures

- `mock_docker_client`: Mocked Docker SDK client
- `mock_executor_config`: Mock executor configuration

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
    └── test_crypto.py       # Encryption/decryption tests
```

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

1. **test-backend**: Python backend tests (Python 3.9, 3.10)
2. **test-executor**: Executor engine tests
3. **test-executor-manager**: Task manager tests
4. **test-shared**: Shared utilities tests
5. **test-frontend**: Frontend tests (Node.js 18.x)
6. **test-summary**: Aggregate results

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
2. **Descriptive names**: Use clear, descriptive test function names
3. **AAA pattern**: Arrange, Act, Assert
4. **Mock external dependencies**: Never call real external services
5. **Use fixtures**: Share common test setup via fixtures

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

### Async Tests

```python
@pytest.mark.asyncio
async def test_async_function():
    """Test asynchronous function"""
    result = await async_function()
    assert result is not None
```

## Adding New Tests

### Backend

1. Create test file in appropriate `tests/` subdirectory
2. Import necessary fixtures from `conftest.py`
3. Write test classes and methods
4. Run tests locally before committing

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

- `backend/pytest.ini`: pytest configuration
- `backend/.coveragerc`: Coverage settings

### Executor/Executor Manager/Shared

- `pytest.ini`: Module-specific pytest config

### Frontend

- `frontend/jest.config.ts`: Jest configuration
- `frontend/jest.setup.js`: Test environment setup

## Future Improvements

- [ ] Increase coverage to 70-80%
- [ ] Add integration tests for API endpoints
- [ ] Add E2E tests for critical user flows
- [ ] Performance/load testing
- [ ] Mutation testing with `mutmut`

## Troubleshooting

### Common Issues

**Import errors in tests:**
- Ensure you're running pytest from the correct directory
- Check that modules are installed: `pip install -r requirements.txt`

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
