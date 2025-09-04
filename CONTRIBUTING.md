# Contributing Guide

Welcome to contribute to the Wegent project! Wegent is an AI agent-based intelligent code generation and automated execution platform with a cloud-native microservices architecture. We warmly welcome all forms of contributions, including but not limited to code submissions, documentation improvements, bug reports, and feature suggestions.

## 📋 Table of Contents

- [Project Overview](#project-overview)
- [Development Environment Setup](#development-environment-setup)
- [Project Architecture](#project-architecture)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Commit Conventions](#commit-conventions)
- [Testing Requirements](#testing-requirements)
- [Documentation Requirements](#documentation-requirements)
- [Bug Reports](#bug-reports)
- [Feature Requests](#feature-requests)
- [Code Review](#code-review)
- [Release Process](#release-process)

## 🎯 Project Overview

Wegent is an AI agent management platform based on Kubernetes-style CRD design, with key features including:

- **Cloud-Native Architecture**: Microservices architecture supporting horizontal scaling
- **Declarative API**: Kubernetes-style CRD resource management
- **AI Agent Ecosystem**: Supporting core concepts like Ghost, Model, Shell, Bot
- **Task Collaboration**: Team and Task mechanisms for multi-agent collaboration
- **Containerized Execution**: Isolated execution environments ensuring security

### Core Components

- **Frontend**: Next.js + TypeScript + Tailwind CSS
- **Backend**: FastAPI + SQLAlchemy + MySQL
- **Executor**: Python + Docker containers
- **Executor Manager**: Task scheduling and management
- **AI Services**: Claude Code (supporting more model extensions)

## 🛠️ Development Environment Setup

### Prerequisites

- Docker >= 20.10
- Docker Compose >= 2.0
- Node.js >= 18.0 (for frontend development)
- Python >= 3.9 (for backend development)
- Git

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-org/Wegent.git
   cd Wegent
   ```

2. **Start all services**
   ```bash
   docker-compose up -d
   ```

3. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:8000
   - API Documentation: http://localhost:8000/docs

### Local Development Environment

#### Frontend Development

```bash
cd frontend
npm install
npm run dev
```

#### Backend Development

```bash
cd backend
pip install -r requirements.txt
# Configure environment variables
export DATABASE_URL="mysql://user:password@localhost/wegent"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

#### Executor Development

```bash
cd executor
pip install -r requirements.txt
python main.py
```

## 🏗️ Project Architecture

### Directory Structure

```
Wegent/
├── frontend/          # Next.js frontend application
│   ├── src/
│   │   ├── app/       # App Router pages
│   │   ├── apis/      # API clients
│   │   ├── features/  # Feature modules
│   │   └── types/     # TypeScript type definitions
│   └── package.json
├── backend/           # FastAPI backend service
│   ├── app/
│   │   ├── api/       # API routes
│   │   ├── core/      # Core configuration
│   │   ├── models/    # Data models
│   │   ├── schemas/   # Pydantic schemas
│   │   └── services/  # Business logic
│   └── requirements.txt
├── executor/          # Task executor
├── executor_manager/  # Executor manager
├── shared/           # Shared utilities and models
└── docker/           # Docker configuration files
```

### CRD Resource Model

The project adopts Kubernetes-style CRD design with core resources including:

- **Ghost** 👻: AI agent's soul and behavior definition
- **Model** 🧠: AI model configuration
- **Shell** 🐚: Runtime environment configuration
- **Bot** 🤖: Specific agent instances
- **Team** 👥: Agent collaboration teams
- **Workspace** 💼: Work environments
- **Task** 🎯: Executable tasks

## 🔄 Development Workflow

### 1. Create Branch

```bash
# Create feature branch from main
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

### 2. Development Work

- Follow code standards
- Write unit tests
- Update related documentation
- Ensure code passes all checks

### 3. Commit Code

```bash
git add .
git commit -m "feat: add new feature description"
git push origin feature/your-feature-name
```

### 4. Create Pull Request

- Fill out complete PR description
- Link related issues
- Request code review
- Respond to review feedback

## 📝 Code Standards

### Python Code Standards (Backend/Executor)

- Follow PEP 8 standards
- Use Black for code formatting
- Use isort for import organization
- Use pylint for code checking

```bash
# Code formatting
black .
isort .

# Code checking
pylint app/
```

### TypeScript Code Standards (Frontend)

- Use ESLint + Prettier
- Follow TypeScript best practices
- Use strict type checking

```bash
# Code checking and formatting
npm run lint
npm run format
```

### General Standards

- Use descriptive naming for functions and variables
- Add necessary comments and docstrings
- Keep code clean and readable
- Avoid duplicate code, extract common logic

## 📨 Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Commit Types

- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation updates
- `style`: Code formatting
- `refactor`: Code refactoring
- `test`: Test-related
- `chore`: Build and tooling-related

### Examples

```
feat(backend): add user authentication API

fix(frontend): resolve task status display issue

docs: update contributing guide

refactor(executor): improve error handling
```

## 🧪 Testing Requirements

### Backend Testing

- Use pytest for unit testing
- API tests covering all endpoints
- Database operation tests
- At least 80% code coverage

```bash
cd backend
pytest tests/ --cov=app --cov-report=html
```

### Frontend Testing

- Use Jest + React Testing Library
- Component unit tests
- API integration tests
- E2E tests (Playwright)

```bash
cd frontend
npm run test
npm run test:e2e
```

### Executor Testing

- Mock AI service responses
- Container environment tests
- Error handling tests

## 📚 Documentation Requirements

### API Documentation

- Use FastAPI auto-generated Swagger documentation
- Add detailed descriptions for all endpoints
- Provide request/response examples

### Code Documentation

- Python: Use docstring format
- TypeScript: Use JSDoc comments
- Add inline comments for complex logic

### User Documentation

- Keep README.md up to date
- Feature usage guides
- Troubleshooting documentation

## 🐛 Bug Reports

When reporting bugs using GitHub Issues, please include:

1. **Environment Information**
   - Operating system
   - Docker version
   - Browser version (for frontend issues)

2. **Reproduction Steps**
   - Detailed operation steps
   - Expected behavior
   - Actual behavior

3. **Related Logs**
   - Error messages
   - Console output
   - Service logs

4. **Screenshots or Screen Recording** (if applicable)

## 💡 Feature Requests

When submitting feature requests, please describe:

- Feature description and use cases
- Expected user experience
- Possible implementation approaches
- Impact on existing features

## 👀 Code Review

### Review Checklist

- [ ] Code follows standards
- [ ] Features correctly implemented
- [ ] Sufficient test coverage
- [ ] Documentation updated completely
- [ ] Performance impact assessed
- [ ] Security considerations
- [ ] Backward compatibility

### Review Principles

- Constructive feedback
- Focus on code quality
- Consider maintainability
- Respect different viewpoints

## 🚀 Release Process

### Version Management

Use Semantic Versioning (SemVer):

- `MAJOR.MINOR.PATCH`
- Major version: Incompatible API changes
- Minor version: Backward-compatible feature additions
- Patch version: Backward-compatible bug fixes

### Release Steps

1. Update version number
2. Update CHANGELOG.md
3. Create release branch
4. Code review and testing
5. Merge to main branch
6. Create Git tag
7. Build and publish Docker images

## 🤝 Community Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment for everyone. Please follow these principles:

- Use friendly and inclusive language
- Respect different viewpoints and experiences
- Gracefully accept constructive criticism
- Focus on what is best for the community
- Show empathy towards other community members

## 📞 Contact

If you have any questions, feel free to contact us through:

- GitHub Issues: Report bugs and feature requests
- GitHub Discussions: Community discussions and Q&A
- Email: [maintainer email]

## 📄 License

This project is licensed under the Apache 2.0 License. By contributing code, you agree that your contributions will be licensed under the same license.

---

Thank you for contributing to the Wegent project! 🎉