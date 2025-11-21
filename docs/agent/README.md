# Wegent AI Agent Documentation System

This directory contains comprehensive documentation for AI agents working on the Wegent project. All documentation is written in English and designed to be agent-friendly with clear instructions, code examples, and cross-references.

## Documentation Files

### Core Documentation

1. **[architecture.md](./architecture.md)** - System Architecture
   - Complete system overview with frontend/backend structure
   - Core concepts (Ghost, Bot, Team, Workspace, Task)
   - Data flow patterns and communication protocols
   - Security architecture and performance optimization
   - Technology stack and deployment architecture

2. **[api-conventions.md](./api-conventions.md)** - API Design Standards
   - RESTful API design principles
   - Kubernetes-style resource API conventions
   - Authentication and authorization patterns
   - Request/response formats and error handling
   - Complete code examples for backend and frontend

3. **[code-style.md](./code-style.md)** - Coding Standards
   - Python/Backend style guide (PEP 8, type hints, docstrings)
   - TypeScript/Frontend style guide (React, hooks, components)
   - Naming conventions for all code elements
   - Code organization and file structure
   - Documentation standards and Git commit guidelines

4. **[testing-guide.md](./testing-guide.md)** - Testing Practices
   - Testing framework overview (pytest, Jest)
   - Backend testing with pytest and fixtures
   - Frontend testing with Testing Library
   - Test coverage requirements (80%+ target)
   - Testing patterns and CI/CD integration

### Implementation Examples

5. **[frontend-examples.md](./frontend-examples.md)** - Frontend Examples
   - Example 1: Creating a new resource list component
   - Example 2: Implementing a form with validation
   - Example 3: Adding real-time updates with WebSocket
   - Example 4: Creating a custom hook for API integration
   - Example 5: Implementing i18n for a new feature

6. **[backend-examples.md](./backend-examples.md)** - Backend Examples
   - Example 1: Creating a new API endpoint
   - Example 2: Implementing business logic in service layer
   - Example 3: Adding database model with relationships
   - Example 4: Implementing authentication middleware
   - Example 5: Creating background jobs

7. **[fullstack-examples.md](./fullstack-examples.md)** - Full-Stack Examples
   - Example 1: Complete Ghost management feature
   - Example 2: Real-time task monitoring system
   - Example 3: Team sharing and collaboration

8. **[testing-examples.md](./testing-examples.md)** - Testing Examples
   - Example 1: Unit testing security functions
   - Example 2: Integration testing API endpoints
   - Example 3: Frontend component testing
   - Example 4: Testing database models and relationships
   - Example 5: End-to-end workflow testing

9. **[documentation-examples.md](./documentation-examples.md)** - Documentation Examples
   - Example 1: Writing comprehensive function docstrings
   - Example 2: Documenting API endpoints
   - Example 3: Creating user guide documentation
   - Example 4: Writing architectural decision records (ADR)
   - Example 5: Maintaining CHANGELOG and release notes

## Quick Start for AI Agents

### Understanding the System

1. Start with [architecture.md](./architecture.md) to understand the overall system design
2. Review [api-conventions.md](./api-conventions.md) for API standards
3. Read [code-style.md](./code-style.md) for coding conventions

### Implementing Features

1. Check relevant example files:
   - Frontend work → [frontend-examples.md](./frontend-examples.md)
   - Backend work → [backend-examples.md](./backend-examples.md)
   - Full-stack work → [fullstack-examples.md](./fullstack-examples.md)

2. Follow the step-by-step instructions
3. Refer to validation sections to verify implementation
4. Watch out for common pitfalls listed in each example

### Writing Tests

1. Review [testing-guide.md](./testing-guide.md) for testing standards
2. Check [testing-examples.md](./testing-examples.md) for specific examples
3. Ensure coverage meets minimum requirements (80%+)

### Creating Documentation

1. Follow examples in [documentation-examples.md](./documentation-examples.md)
2. Use Google-style docstrings for Python
3. Use JSDoc comments for TypeScript
4. Maintain CHANGELOG and release notes

## File Locations Reference

### Frontend
- Source code: `/workspace/12738/Wegent/frontend/src/`
- Components: `/workspace/12738/Wegent/frontend/src/components/`
- API clients: `/workspace/12738/Wegent/frontend/src/apis/`
- Types: `/workspace/12738/Wegent/frontend/src/types/`
- Tests: `/workspace/12738/Wegent/frontend/src/**/__tests__/`

### Backend
- Source code: `/workspace/12738/Wegent/backend/app/`
- API endpoints: `/workspace/12738/Wegent/backend/app/api/endpoints/`
- Models: `/workspace/12738/Wegent/backend/app/models/`
- Services: `/workspace/12738/Wegent/backend/app/services/`
- Tests: `/workspace/12738/Wegent/backend/tests/`

## Technology Stack Summary

### Frontend
- **Framework**: Next.js 15.1.3 (App Router)
- **UI Library**: React 19.0.0
- **Language**: TypeScript 5.7.3
- **Styling**: Tailwind CSS 3.4.16, Radix UI
- **State**: React Hook Form 7.66.1, Zod 4.1.12
- **Testing**: Jest 29.7.0, Testing Library

### Backend
- **Framework**: FastAPI >= 0.68.0
- **Language**: Python 3.9+
- **ORM**: SQLAlchemy >= 2.0.28
- **Database**: MySQL 9.4, Redis 7
- **Auth**: PyJWT >= 2.8.0, Authlib
- **Testing**: pytest >= 7.4.0

## Key Concepts

### Resources (Kubernetes-style CRD)
- **Ghost**: Agent personality and capabilities
- **Model**: AI model configuration
- **Shell**: Runtime environment
- **Bot**: Complete agent (Ghost + Model + Shell)
- **Team**: Collaboration group of Bots
- **Workspace**: Code repository environment
- **Task**: Executable work unit

### Collaboration Models
- **Pipeline**: Sequential execution (A → B → C)
- **Route**: Leader routes to appropriate bot
- **Coordinate**: Leader coordinates parallel execution
- **Collaborate**: Free discussion with shared context

## Best Practices

### For AI Agents

1. **Always read architecture.md first** - Understand the system before making changes
2. **Follow code style guidelines** - Maintain consistency across the codebase
3. **Write tests for all changes** - Ensure quality and prevent regressions
4. **Use examples as templates** - Adapt proven patterns for new features
5. **Document your work** - Help future agents (and humans) understand your changes
6. **Check common pitfalls** - Avoid known issues in each example
7. **Cross-reference documentation** - Use related docs links to understand context
8. **Validate your work** - Follow validation steps in each example

### Code Quality

- Maintain 80%+ test coverage
- Use type hints in Python and TypeScript
- Write descriptive commit messages
- Follow naming conventions
- Document all public APIs
- Handle errors gracefully

### Security

- Never commit secrets or credentials
- Use environment variables for configuration
- Validate all user input
- Implement proper authentication
- Follow security best practices

## Getting Help

If you encounter issues:

1. Check the relevant documentation file
2. Review the examples for similar patterns
3. Look for common pitfalls sections
4. Verify prerequisites are met
5. Check validation steps

## Related Resources

- User Documentation: `/workspace/12738/Wegent/docs/en/`
- Existing Architecture: `/workspace/12738/Wegent/docs/en/concepts/architecture.md`
- Core Concepts: `/workspace/12738/Wegent/docs/en/concepts/core-concepts.md`
- API Reference: Check FastAPI docs at `/api/docs` when server is running

## File Statistics

Total documentation: 12 files (optimized for AI agents)

| File | Size | Examples | Purpose |
|------|------|----------|---------|
| architecture.md | 25KB | - | System overview |
| api-conventions.md | 19KB | 10+ | API standards |
| code-style.md | 21KB | 15+ | Coding style |
| testing-guide.md | 21KB | 10+ | Testing practices |
| tech-stack.md | 3.6KB | - | Technology reference |
| design-system.md | 4.9KB | - | UI design system |
| frontend-examples.md | 5.4KB | 2-3 | Frontend patterns |
| backend-examples.md | 4.6KB | 2-3 | Backend patterns |
| fullstack-examples.md | 4.8KB | 2 | Full-stack patterns |
| testing-examples.md | 4.5KB | 2-3 | Testing patterns |
| documentation-examples.md | 4.4KB | 2-3 | Documentation patterns |

**Total**: ~118KB of concise, agent-optimized documentation (88% smaller than original)

## Last Updated

**Date**: 2025-01-22
**Version**: 1.0.0

---

**Note**: This documentation is optimized for AI agents. Files use absolute paths, concise patterns (not tutorials), and quick-reference format to enable autonomous work with minimal token usage.
