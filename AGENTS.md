# AGENTS.md

Wegent is an open-source AI-native operating system for defining, organizing, and running intelligent agent teams. This guide provides comprehensive instructions for AI coding agents working on this multi-module project.

## 📋 Project Overview

Wegent is built on a microservices architecture with the following core components:

- **Frontend** (Next.js 15 + TypeScript + React 19): Web-based management interface
- **Backend** (FastAPI + SQLAlchemy + MySQL): RESTful API and business logic
- **Executor**: Task execution engine running AI agents (Claude Code, Agno)
- **Executor Manager**: Task orchestration and Docker container management
- **Shared**: Common utilities and data models used across modules

### Architecture Principles

- **Kubernetes-inspired CRD design**: Declarative API for resources (Ghost, Model, Shell, Bot, Team, Task)
- **Containerized execution**: Each agent team runs in isolated sandboxes
- **Cloud-native**: Horizontal scaling, service mesh ready
- **High cohesion, low coupling**: Keep related logic together, avoid scattered implementations

---

## 🚀 Setup Commands

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/wecode-ai/wegent.git
cd wegent

# Quick start with Docker Compose (recommended for first-time setup)
docker-compose up -d
```

### Access Points

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Documentation: http://localhost:8000/api/docs
- MySQL: localhost:3306
- Redis: localhost:6379
- Executor Manager: http://localhost:8001

### Module-Specific Setup

#### Backend Development

```bash
cd backend
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your database and Redis URLs

# Run development server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Database initialization**: Tables and initial data are created automatically on first startup from YAML files in `backend/init_data/`. See `backend/init_data/README.md` for details.

#### Frontend Development

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:3000 by default.

#### Executor Development

```bash
cd executor
pip install -r requirements.txt
python main.py
```

#### Executor Manager Development

```bash
cd executor_manager
pip install -r requirements.txt
python main.py
```

---

## 🧪 Testing Instructions

Wegent uses comprehensive testing across all modules. **Always run tests before committing changes.**

### Backend Tests

```bash
cd backend
# Run all tests
pytest

# Run with coverage report
pytest --cov=app --cov-report=html

# Run only unit tests
pytest -m unit

# Run specific test file
pytest tests/test_api.py
```

**Testing framework**: pytest + pytest-asyncio + pytest-cov + pytest-mock
**Target coverage**: Maintain minimum 40-60%, target 70-80%

### Frontend Tests

```bash
cd frontend
# Run all tests
npm test

# Run in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

**Testing framework**: Jest + React Testing Library + MSW (for API mocking)

### Executor Tests

```bash
cd executor
pytest tests/ --cov=agents

# Run specific test markers
pytest -m "not slow"
```

### Executor Manager Tests

```bash
cd executor_manager
pytest tests/ --cov=executors
```

### Shared Module Tests

```bash
cd shared
pytest tests/ --cov=utils
```

### Testing Best Practices

1. **Follow AAA Pattern**: Arrange, Act, Assert
2. **Mock external services**: Never call real APIs (Anthropic, OpenAI, Docker) in tests
3. **Use descriptive test names**: Clearly indicate what behavior is being tested
4. **Test edge cases**: Include error conditions and boundary values
5. **Keep tests independent**: Each test should run in isolation
6. **Use fixtures**: Share common setup via pytest fixtures (Python) or beforeEach (Jest)

### CI/CD

All tests run automatically via GitHub Actions on:
- Push to `main`, `master`, or `develop` branches
- All pull requests

Tests must pass before merging.

---

## 💻 Code Style

### Python Code (Backend, Executor, Executor Manager, Shared)

- **Style guide**: PEP 8
- **Formatter**: Black (line length: 88)
- **Import organizer**: isort
- **Linter**: pylint, flake8
- **Type hints**: Use type annotations for functions and classes

```bash
# Format code
black .
isort .

# Lint code
pylint app/
flake8 app/
```

**Key conventions**:
- Use descriptive variable and function names
- Add docstrings to all public functions and classes
- Avoid magic numbers; use constants
- Keep functions focused and short (max 50 lines preferred)

### TypeScript/React Code (Frontend)

- **TypeScript**: Strict mode enabled
- **Style**: Functional components with hooks
- **Formatter**: Prettier
- **Linter**: ESLint (Next.js config)

```bash
# Format code
npm run format

# Lint code
npm run lint
```

**Key conventions**:
- Use functional patterns where possible
- Prefer `const` over `let`, avoid `var`
- Use single quotes for strings
- No semicolons (Prettier enforced)
- Component names in PascalCase, files in kebab-case
- Place interfaces/types in `src/types/`

### General Guidelines

- **DRY principle**: Don't repeat yourself; extract common logic
- **High cohesion**: Keep related functionality together
- **Low coupling**: Minimize dependencies between modules
- **Simplicity**: Choose the simplest solution that works
- **Comments**: Explain *why*, not *what* (code should be self-documenting)

---

## 🔄 Development Workflow

### Branch Strategy

```bash
# Create feature branch from main
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

**Branch naming conventions**:
- `feature/`: New features (e.g., `feature/add-ghost-api`)
- `fix/`: Bug fixes (e.g., `fix/task-status-update`)
- `refactor/`: Code refactoring (e.g., `refactor/simplify-executor-logic`)
- `docs/`: Documentation updates (e.g., `docs/update-api-guide`)
- `test/`: Test additions/improvements (e.g., `test/add-bot-integration-tests`)
- `chore/`: Build/tooling changes (e.g., `chore/update-dependencies`)

### Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Commit types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code formatting (no functional changes)
- `refactor`: Code refactoring
- `test`: Test additions/modifications
- `chore`: Build scripts, dependencies, tooling

**Examples**:
```
feat(backend): add user authentication API

fix(frontend): resolve task status display issue

docs: update AGENTS.md with testing instructions

refactor(executor): simplify agent initialization logic
```

### Pre-commit Checklist

Before committing, ensure:

- [ ] Code follows style guidelines (run formatters)
- [ ] All tests pass (`pytest` for Python, `npm test` for frontend)
- [ ] No linting errors (`pylint`, `npm run lint`)
- [ ] Added tests for new features or bug fixes
- [ ] Updated documentation if API or behavior changed
- [ ] Commit message follows conventions

---

## 📦 Pull Request Guidelines

### PR Title Format

Use Conventional Commits format:
```
<type>[scope]: <Title>
```

**Examples**:
```
feat(backend): Add Ghost YAML import functionality
fix(frontend): Fix team creation form validation
docs: Update contributing guide with testing details
```

### PR Description Template

```markdown
## Summary
Brief description of what this PR does and why.

## Changes
- Bullet point list of key changes
- Another change

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

## Screenshots (if applicable)
[Add screenshots for UI changes]

## Related Issues
Closes #123
Related to #456
```

### PR Checklist

Before requesting review:

- [ ] All tests pass locally
- [ ] Code coverage maintained or improved
- [ ] No merge conflicts with target branch
- [ ] Documentation updated (if needed)
- [ ] CHANGELOG.md updated (for significant changes)
- [ ] Commit history is clean and logical

### Review Process

1. Create PR from your feature branch to `main`
2. Assign at least one reviewer
3. Address review feedback promptly
4. Keep PR scope focused (prefer smaller PRs)
5. Squash commits if history is messy before merging

---

## 🏗️ Project Structure Deep Dive

### Directory Layout

```
wegent/
├── backend/               # FastAPI backend service
│   ├── app/
│   │   ├── api/          # API route handlers
│   │   ├── core/         # Core configuration (settings, security)
│   │   ├── models/       # SQLAlchemy ORM models
│   │   ├── schemas/      # Pydantic schemas for validation
│   │   └── services/     # Business logic layer
│   ├── init_data/        # YAML-based initialization data
│   └── tests/            # Backend tests
├── frontend/             # Next.js web interface
│   ├── src/
│   │   ├── app/          # App Router pages and layouts
│   │   ├── apis/         # API client functions
│   │   ├── features/     # Feature-based modules
│   │   └── types/        # TypeScript type definitions
│   └── public/           # Static assets
├── executor/             # Task execution engine
│   ├── agents/           # Agent implementations (Claude Code, Agno)
│   ├── tasks/            # Task handlers
│   ├── services/         # Executor services
│   └── tests/            # Executor tests
├── executor_manager/     # Execution orchestration
│   ├── executors/        # Executor lifecycle management
│   ├── routers/          # API routes
│   ├── scheduler/        # Task scheduling
│   └── tests/            # Executor Manager tests
├── shared/               # Common utilities
│   ├── models/           # Shared data models
│   ├── utils/            # Utility functions
│   └── logger.py         # Centralized logging
├── docker/               # Docker configurations
└── docs/                 # Documentation (EN + ZH)
```

### Navigation Tips

**Finding files**:
- Use `find` to locate files by name: `find . -name "*.py" | grep service`
- Use `grep -r` to search for keywords: `grep -r "class Ghost" backend/`
- Check module READMEs: `backend/README.md`, `executor_manager/README.md`

**Understanding data flow**:
1. User creates task via Frontend
2. Frontend calls Backend API
3. Backend stores task in MySQL, sends to Executor Manager
4. Executor Manager spawns Docker container with Executor
5. Executor runs AI agent (Claude Code/Agno)
6. Results flow back through callback chain

---

## 🔒 Security Considerations

### API Keys and Secrets

- **Never commit secrets**: Use environment variables
- **Backend**: Store in `.env` file (excluded from git)
- **Frontend**: Prefix with `NEXT_PUBLIC_` only for client-safe values
- **Executor**: Pass via environment variables in Docker

### Git Token Encryption

Backend encrypts Git tokens before storing in database. See `backend/MIGRATION_GIT_TOKEN_ENCRYPTION.md` for migration details.

### Database Credentials

Default credentials in `docker-compose.yml` are for development only. **Change in production**:
- `MYSQL_ROOT_PASSWORD`
- `MYSQL_PASSWORD`
- `SECRET_KEY` (JWT signing key)

---

## 🐛 Debugging Tips

### Backend Debugging

```bash
# Enable debug logging
export LOG_LEVEL=DEBUG
uvicorn app.main:app --reload --log-level debug

# Check database connection
mysql -u task_user -ptask_password -h localhost task_manager

# View logs
docker logs -f wegent-backend
```

### Frontend Debugging

```bash
# Enable verbose logging
npm run dev -- --debug

# Check API calls in browser DevTools Network tab
# Use React DevTools for component inspection
```

### Executor Debugging

```bash
# Run executor directly with debug logs
cd executor
LOG_LEVEL=DEBUG python main.py

# Check executor container logs
docker logs -f <executor-container-id>
```

### Common Issues

1. **Database connection failed**: Check MySQL is running, credentials match
2. **Port already in use**: Stop conflicting services or change ports in docker-compose.yml
3. **Module import errors**: Ensure virtual environment is activated and dependencies installed
4. **Frontend build fails**: Clear `.next` cache: `rm -rf .next && npm run build`

---

## 📚 Documentation Requirements

### Code Documentation

**Python**:
```python
def create_task(task_data: dict) -> Task:
    """Create a new task in the system.

    Args:
        task_data: Dictionary containing task configuration

    Returns:
        Task: Created task instance

    Raises:
        ValueError: If task_data is invalid
    """
    # Implementation
```

**TypeScript**:
```typescript
/**
 * Creates a new task via API
 * @param taskData - Task configuration object
 * @returns Promise resolving to created task
 * @throws {ApiError} If request fails
 */
async function createTask(taskData: TaskData): Promise<Task> {
  // Implementation
}
```

### API Documentation

Backend uses FastAPI auto-generated OpenAPI docs at `/api/docs`. When adding endpoints:

1. Use Pydantic schemas for request/response models
2. Add clear descriptions to route decorators
3. Include example values in schema fields
4. Document error responses

### User-Facing Documentation

Located in `docs/en/` (English) and `docs/zh/` (Chinese):

- **Update when**: Adding features, changing behavior, fixing bugs
- **Includes**: User guides, developer guides, API reference, troubleshooting
- **Format**: Markdown with clear headings, code examples, screenshots

---

## 🚢 Release Process

### Version Management

Wegent follows [Semantic Versioning](https://semver.org/):

- `MAJOR.MINOR.PATCH` (e.g., `1.0.7`)
- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes

### Release Checklist

1. [ ] Update version in `docker-compose.yml` image tags
2. [ ] Update CHANGELOG.md with release notes
3. [ ] Run full test suite on all modules
4. [ ] Build Docker images: `./build_image.sh` (or `build_image_mac.sh` on macOS)
5. [ ] Tag release: `git tag -a v1.0.8 -m "Release 1.0.8"`
6. [ ] Push to GitHub: `git push origin v1.0.8`
7. [ ] Create GitHub Release with notes
8. [ ] Update documentation if needed

---

## 🔧 Module-Specific Guidance

### Backend (`backend/`)

**Key technologies**: FastAPI, SQLAlchemy, Pydantic, MySQL, Redis

**Common tasks**:
- Adding API endpoint: Create route in `app/api/`, add schema in `app/schemas/`, implement logic in `app/services/`
- Adding database model: Create in `app/models/`, run migration or restart (auto-create enabled)
- Adding background task: Use FastAPI BackgroundTasks or implement in services

**Environment variables** (see `backend/.env.example`):
- `DATABASE_URL`: MySQL connection string
- `REDIS_URL`: Redis connection string
- `SECRET_KEY`: JWT signing key
- `EXECUTOR_DELETE_TASK_URL`: Executor Manager endpoint

### Frontend (`frontend/`)

**Key technologies**: Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui

**Common tasks**:
- Adding page: Create in `src/app/` (App Router)
- Adding API call: Add function in `src/apis/`
- Adding component: Create in `src/features/<feature>/components/`
- Adding type: Define in `src/types/`

**Environment variables**:
- `NEXT_PUBLIC_API_URL`: Backend API base URL (for client-side calls)

### Executor (`executor/`)

**Key technologies**: Python, Claude Code SDK, Agno, Docker

**Common tasks**:
- Adding new agent type: Implement in `agents/`
- Modifying task execution: Update `tasks/`
- Adding callback logic: Modify `callback/`

**Environment variables** (passed from Executor Manager):
- `ANTHROPIC_AUTH_TOKEN` (for Claude Code)
- `ANTHROPIC_API_KEY` (for Agno)
- `TASK_ID`, `CALLBACK_URL`, etc.

### Executor Manager (`executor_manager/`)

**Key technologies**: Python, Docker SDK, FastAPI

**Common tasks**:
- Modifying executor lifecycle: Update `executors/`
- Adding task scheduling logic: Modify `scheduler/`
- Adding API endpoint: Create in `routers/`

**Environment variables**:
- `TASK_API_DOMAIN`: Backend API URL
- `EXECUTOR_IMAGE`: Docker image for executors
- `MAX_CONCURRENT_TASKS`: Concurrent task limit
- `NETWORK`: Docker network name

### Shared (`shared/`)

**Key technologies**: Python utilities, common models

**Usage**: Import shared utilities in other modules:
```python
from shared.logger import get_logger
from shared.models import TaskStatus
```

**Common tasks**:
- Adding utility function: Create in `utils/`
- Adding shared model: Create in `models/`

---

## 📖 Additional Resources

- **Main README**: [README.md](README.md) - Project overview
- **Contributing Guide**: [CONTRIBUTING.md](CONTRIBUTING.md) - Detailed contribution instructions
- **Developer Setup**: [docs/en/guides/developer/setup.md](docs/en/guides/developer/setup.md) - Comprehensive setup guide
- **Testing Guide**: [docs/en/guides/developer/testing.md](docs/en/guides/developer/testing.md) - Testing framework details
- **YAML Specification**: [docs/en/reference/yaml-specification.md](docs/en/reference/yaml-specification.md) - CRD resource definitions
- **Architecture**: [docs/en/concepts/architecture.md](docs/en/concepts/architecture.md) - System architecture

---

## 🎯 Quick Reference

### Most Common Commands

```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose down

# View logs
docker-compose logs -f [service-name]

# Rebuild specific service
docker-compose up -d --build [service-name]

# Run backend tests
cd backend && pytest

# Run frontend tests
cd frontend && npm test

# Format Python code
black . && isort .

# Format TypeScript code
npm run format

# Access MySQL
docker exec -it wegent-mysql mysql -u root -p123456 task_manager

# Access Redis
docker exec -it wegent-redis redis-cli
```

### Key Ports

- **3000**: Frontend
- **8000**: Backend API
- **8001**: Executor Manager
- **3306**: MySQL
- **6379**: Redis
- **10001-10100**: Executor containers (dynamic)

---

## 🤝 Getting Help

If you encounter issues or have questions:

1. Check existing documentation in `docs/`
2. Search GitHub Issues: https://github.com/wecode-ai/wegent/issues
3. Create new issue with detailed reproduction steps
4. For security issues, email maintainers directly (see CONTRIBUTING.md)

---

**Last Updated**: 2025-01
**Wegent Version**: 1.0.7
**Maintained by**: WeCode-AI Team
