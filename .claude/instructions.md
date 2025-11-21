# Wegent AI Agent Instructions

## 📋 Project Overview

**Wegent** is an open-source AI native operating system that enables teams to build, configure, and deploy collaborative AI agent systems. It provides a declarative, Kubernetes-style API for managing AI agents, teams, and workspaces.

### Purpose
Wegent simplifies the creation and orchestration of multi-agent systems by providing:
- Declarative YAML-based configuration for AI agents (Ghosts, Bots, Teams)
- Multiple collaboration models (Pipeline, Route, Coordinate, Collaborate)
- Isolated execution environments for secure task processing
- A modern web platform for managing AI workflows

### Architecture
- **Frontend**: Next.js 15 + React 19 + TypeScript + Tailwind CSS + shadcn/ui
- **Backend**: FastAPI + Python + SQLAlchemy + MySQL + Redis
- **Execution Layer**: Docker-based isolated sandboxes for agent execution
- **Agent Layer**: Claude Code, Agno (experimental), and planned integrations

For detailed architecture information, see [`docs/agent/architecture.md`](../docs/agent/architecture.md).

---

## 🤖 Agent Role Definitions

As an AI agent working on the Wegent project, you will be assigned one of the following roles based on the user's explicit instruction. Each role has specific responsibilities and required knowledge.

### 1. Frontend Developer Agent 👨‍💻

**Activation**: User says "As a frontend agent..." or "Frontend agent, help me..."

**Responsibilities**:
- Develop UI/UX components using React 19 and Next.js 15
- Implement responsive designs with Tailwind CSS and shadcn/ui
- Create and maintain Radix UI-based components
- Handle form validation with react-hook-form and Zod
- Implement internationalization (i18next)
- Ensure accessibility and design system compliance

**Key Documents to Reference**:
- [`docs/agent/design-system.md`](../docs/agent/design-system.md) - Calm UI design principles, color system, components
- [`docs/agent/tech-stack.md`](../docs/agent/tech-stack.md) - Frontend technology stack
- [`docs/agent/architecture.md`](../docs/agent/architecture.md) - Frontend folder structure
- [`docs/agent/code-style.md`](../docs/agent/code-style.md) - Frontend coding standards
- [`docs/agent/frontend-examples.md`](../docs/agent/frontend-examples.md) - Step-by-step task examples

**Code Locations**:
- Components: `frontend/src/components/ui/`
- Features: `frontend/src/features/`
- App routes: `frontend/src/app/`
- APIs: `frontend/src/apis/`
- Types: `frontend/src/types/`

---

### 2. Backend Developer Agent ⚙️

**Activation**: User says "As a backend agent..." or "Backend agent, help me..."

**Responsibilities**:
- Develop REST APIs with FastAPI
- Design database schemas and migrations (SQLAlchemy + Alembic)
- Implement authentication and authorization (JWT, OAuth, CAS)
- Write business logic in service layer
- Manage data repositories and database operations
- Implement caching strategies with Redis

**Key Documents to Reference**:
- [`docs/agent/api-conventions.md`](../docs/agent/api-conventions.md) - RESTful API design standards
- [`docs/agent/tech-stack.md`](../docs/agent/tech-stack.md) - Backend technology stack
- [`docs/agent/architecture.md`](../docs/agent/architecture.md) - Backend folder structure
- [`docs/agent/code-style.md`](../docs/agent/code-style.md) - Backend coding standards
- [`docs/agent/backend-examples.md`](../docs/agent/backend-examples.md) - Step-by-step task examples

**Code Locations**:
- API endpoints: `backend/app/api/endpoints/`
- Services: `backend/app/services/`
- Repositories: `backend/app/repository/`
- Models: `backend/app/models/`
- Schemas: `backend/app/schemas/`
- Database: `backend/app/db/`

---

### 3. Fullstack Developer Agent 🌐

**Activation**: User says "As a fullstack agent..." or "Fullstack agent, help me..."

**Responsibilities**:
- Implement end-to-end features from database to UI
- Connect frontend components with backend APIs
- Ensure data flow consistency across layers
- Debug integration issues between frontend and backend
- Implement real-time features (WebSocket integration)

**Key Documents to Reference**:
- All documents in `docs/agent/` directory
- [`docs/agent/fullstack-examples.md`](../docs/agent/fullstack-examples.md) - End-to-end implementation examples
- [`docs/agent/architecture.md`](../docs/agent/architecture.md) - Complete system architecture

**Code Locations**:
- Both frontend and backend codebases

---

### 4. Testing Agent 🧪

**Activation**: User says "As a testing agent..." or "Testing agent, help me..."

**Responsibilities**:
- Write unit tests for frontend and backend components
- Create integration tests for API endpoints
- Implement E2E tests for critical user flows
- Ensure test coverage meets project standards
- Write test fixtures and mocks
- Debug failing tests

**Key Documents to Reference**:
- [`docs/agent/testing-guide.md`](../docs/agent/testing-guide.md) - Testing standards and practices
- [`docs/agent/testing-examples.md`](../docs/agent/testing-examples.md) - Step-by-step testing examples
- [`docs/agent/tech-stack.md`](../docs/agent/tech-stack.md) - Testing frameworks (Jest, pytest)

**Code Locations**:
- Frontend tests: `frontend/__tests__/` or `*.test.ts/tsx` files
- Backend tests: `backend/tests/`

---

### 5. Documentation Agent 📝

**Activation**: User says "As a documentation agent..." or "Documentation agent, help me..."

**Responsibilities**:
- Create and maintain technical documentation
- Update agent documentation when codebase changes
- Write clear API documentation
- Create user guides and examples
- Ensure documentation accuracy and consistency
- Translate documentation when needed

**Key Documents to Reference**:
- [`docs/agent/README.md`](../docs/agent/README.md) - Documentation index and guidelines
- [`docs/agent/documentation-examples.md`](../docs/agent/documentation-examples.md) - Documentation task examples
- All existing documentation in `docs/` directory

**Code Locations**:
- Agent documentation: `docs/agent/`
- User documentation: `docs/en/` and `docs/zh/`
- README files throughout the codebase

---

## 📚 Documentation References

All agent-specific documentation is located in the `docs/agent/` directory:

| Document | Purpose |
|----------|---------|
| [`README.md`](../docs/agent/README.md) | Index and usage guide for agents |
| [`tech-stack.md`](../docs/agent/tech-stack.md) | Complete technology stack reference |
| [`design-system.md`](../docs/agent/design-system.md) | Frontend design system (Calm UI) |
| [`architecture.md`](../docs/agent/architecture.md) | System architecture and data flow |
| [`api-conventions.md`](../docs/agent/api-conventions.md) | Backend API design standards |
| [`code-style.md`](../docs/agent/code-style.md) | Code style and best practices |
| [`testing-guide.md`](../docs/agent/testing-guide.md) | Testing standards and practices |
| [`frontend-examples.md`](../docs/agent/frontend-examples.md) | Frontend task examples |
| [`backend-examples.md`](../docs/agent/backend-examples.md) | Backend task examples |
| [`fullstack-examples.md`](../docs/agent/fullstack-examples.md) | Fullstack task examples |
| [`testing-examples.md`](../docs/agent/testing-examples.md) | Testing task examples |
| [`documentation-examples.md`](../docs/agent/documentation-examples.md) | Documentation task examples |

---

## 🔄 Development Workflow

### Git Workflow

1. **Branch Naming**:
   - Feature branches: `wegent/feature-name`
   - Bug fixes: `wegent/fix-bug-name`
   - Documentation: `wegent/docs-update-name`

2. **Commit Message Format**:
   ```
   <type>(<scope>): <brief description>

   <detailed description if needed>
   ```

   **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

   **Examples**:
   - `feat(frontend): add dark mode toggle to settings page`
   - `fix(backend): resolve authentication token expiration issue`
   - `docs(agent): update API conventions guide`
   - `test(backend): add unit tests for user service`

3. **Commit Best Practices**:
   - Make atomic commits (one logical change per commit)
   - Write clear, descriptive commit messages
   - Reference issue numbers when applicable
   - Keep commits focused and small

### Code Review Process

1. **Before Creating MR**:
   - Run tests locally (`npm test` for frontend, `pytest` for backend)
   - Check code formatting (`npm run format` for frontend, `black` + `isort` for backend)
   - Verify linting passes (`npm run lint` for frontend, `flake8` for backend)

2. **MR Description**:
   - Clearly describe what changed and why
   - Include screenshots for UI changes
   - List any breaking changes
   - Reference related issues

3. **Code Quality Standards**:
   - Follow the code style guide in `docs/agent/code-style.md`
   - Maintain test coverage (minimum 70%)
   - Document public APIs and complex logic
   - Ensure accessibility compliance (WCAG 2.1 AA)

---

## ✅ Quality Standards

### Code Quality Expectations

1. **Readability**:
   - Use descriptive variable and function names
   - Keep functions small and focused (< 50 lines)
   - Add comments for complex logic
   - Follow naming conventions in `docs/agent/code-style.md`

2. **Maintainability**:
   - Apply DRY (Don't Repeat Yourself) principle
   - Use appropriate design patterns
   - Keep dependencies up to date
   - Avoid deep nesting (max 3 levels)

3. **Performance**:
   - Optimize database queries (use indexes, avoid N+1)
   - Minimize bundle size (code splitting, lazy loading)
   - Cache appropriately (Redis for backend, React Query for frontend)
   - Use async/await for I/O operations

4. **Security**:
   - Validate all user inputs
   - Use parameterized queries (prevent SQL injection)
   - Sanitize HTML content (prevent XSS)
   - Never commit secrets or API keys

### Testing Requirements

1. **Unit Tests**:
   - Test individual functions and components
   - Mock external dependencies
   - Aim for 80%+ coverage on new code

2. **Integration Tests**:
   - Test API endpoints with database
   - Test component integration with APIs
   - Verify authentication flows

3. **Test Organization**:
   - Follow AAA pattern (Arrange, Act, Assert)
   - Use descriptive test names
   - Keep tests independent and isolated
   - See `docs/agent/testing-guide.md` for details

### Documentation Standards

1. **Code Documentation**:
   - JSDoc for TypeScript functions (frontend)
   - Docstrings for Python functions (backend)
   - README in each feature directory
   - Inline comments for complex logic

2. **API Documentation**:
   - Document all endpoints in FastAPI (auto-generated)
   - Include request/response examples
   - Describe error responses
   - See `docs/agent/api-conventions.md`

3. **User Documentation**:
   - Keep docs in sync with code changes
   - Use clear, simple language
   - Include code examples
   - Add screenshots for UI features

---

## 🛠️ Development Commands

### Frontend
```bash
npm run dev          # Start development server (http://localhost:3000)
npm run build        # Build for production
npm run lint         # Run ESLint
npm run format       # Run Prettier
npm test             # Run Jest tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

### Backend
```bash
uvicorn app.main:app --reload  # Start development server (http://localhost:8000)
pytest                         # Run all tests
pytest --cov                   # Run tests with coverage
black .                        # Format code with Black
isort .                        # Sort imports
flake8                         # Run linter
mypy .                         # Type checking
alembic upgrade head           # Run database migrations
```

### Docker
```bash
docker-compose up -d           # Start all services
docker-compose down            # Stop all services
docker-compose logs -f backend # View backend logs
docker-compose logs -f frontend # View frontend logs
```

---

## 🎯 Agent Workflow

When assigned a task, follow these steps:

### Step 1: Identify Your Role
- Read the user's instruction carefully
- Determine which agent role you should assume
- Confirm the role with the user if unclear

### Step 2: Gather Context
- Read the relevant documentation from `docs/agent/`
- Review the existing codebase in the relevant locations
- Understand the task requirements fully

### Step 3: Plan the Implementation
- Break down the task into smaller steps
- Identify files to create or modify
- Consider edge cases and error handling
- Refer to example files for similar tasks

### Step 4: Implement the Solution
- Follow code style guidelines
- Write clean, maintainable code
- Add appropriate comments and documentation
- Ensure consistency with existing patterns

### Step 5: Test Your Changes
- Write tests for new functionality
- Run existing tests to ensure no regressions
- Test edge cases and error scenarios
- Verify the changes work as expected

### Step 6: Document Your Changes
- Update relevant documentation
- Add code comments where needed
- Update API documentation if applicable
- Create user-facing docs for new features

### Step 7: Submit for Review
- Create a commit with a clear message
- Push to a wegent/* branch
- Create an MR with a detailed description
- Address review feedback promptly

---

## 🔒 Security Guidelines

1. **Authentication & Authorization**:
   - Always verify user permissions
   - Use JWT tokens for API authentication
   - Never store passwords in plain text
   - Implement proper session management

2. **Data Protection**:
   - Encrypt sensitive data (AES)
   - Use HTTPS for all communications
   - Sanitize user inputs
   - Implement rate limiting

3. **Code Security**:
   - Never commit API keys or secrets
   - Use environment variables for configuration
   - Validate all external inputs
   - Keep dependencies updated

---

## 📝 Notes for Agents

1. **Always Reference Documentation**:
   - Before starting a task, review the relevant docs in `docs/agent/`
   - Follow established patterns and conventions
   - When in doubt, refer to example files

2. **Maintain Consistency**:
   - Use the same coding style as existing code
   - Follow the design system for UI components
   - Keep API responses in consistent format
   - Use established patterns for error handling

3. **Communicate Clearly**:
   - Ask for clarification when requirements are unclear
   - Explain your implementation decisions
   - Document complex logic and edge cases
   - Provide clear error messages

4. **Think Long-Term**:
   - Write maintainable code
   - Consider scalability and performance
   - Make code easy to test
   - Plan for future extensions

5. **Update Documentation**:
   - Keep agent documentation current
   - Update docs when you change code
   - Add examples for new features
   - Fix outdated information

---

## 🔗 Additional Resources

- **Project README**: [`/README.md`](../README.md)
- **Contributing Guide**: [`/CONTRIBUTING.md`](../CONTRIBUTING.md)
- **User Documentation**: [`docs/en/`](../docs/en/) and [`docs/zh/`](../docs/zh/)
- **GitHub Repository**: https://github.com/wecode-ai/Wegent

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
