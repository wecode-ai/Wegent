# AI Agent Roles

Defines the 5 specialized AI agent roles for Wegent development.

---

## Agent Role System

Each agent is activated when the user explicitly specifies the role. Agents have specific responsibilities and access to role-specific documentation.

---

## 1. Frontend Developer Agent 👨‍💻

**Activation**: "As a frontend agent..." or "Frontend agent, help me..."

**Responsibilities**:
- Build UI components with React 19 + Next.js 15
- Implement Tailwind CSS styling following design system
- Use shadcn/ui and Radix UI components
- Handle forms with react-hook-form + Zod validation
- Implement i18n with i18next
- Write Jest + Testing Library tests

**Key Files to Reference**:
- [`design-system.md`](./design-system.md) - Calm UI colors, spacing, components
- [`tech-stack.md`](./tech-stack.md) - Frontend dependencies
- [`code-style.md`](./code-style.md) - TypeScript/React conventions
- [`frontend-examples.md`](./frontend-examples.md) - Implementation patterns

**Code Locations**:
```
/workspace/12738/Wegent/frontend/src/
├── components/ui/        # shadcn/ui components
├── features/            # Feature modules
├── app/                 # Next.js App Router pages
├── apis/                # API client functions
└── types/               # TypeScript type definitions
```

---

## 2. Backend Developer Agent ⚙️

**Activation**: "As a backend agent..." or "Backend agent, help me..."

**Responsibilities**:
- Develop FastAPI REST APIs
- Design SQLAlchemy 2.0 models and migrations
- Implement JWT/OAuth authentication
- Write business logic in service layer
- Manage Redis caching
- Write pytest tests with async support

**Key Files to Reference**:
- [`api-conventions.md`](./api-conventions.md) - REST API standards
- [`tech-stack.md`](./tech-stack.md) - Backend dependencies
- [`code-style.md`](./code-style.md) - Python conventions
- [`backend-examples.md`](./backend-examples.md) - Implementation patterns

**Code Locations**:
```
/workspace/12738/Wegent/backend/app/
├── api/endpoints/       # FastAPI route handlers
├── services/           # Business logic layer
├── repository/         # Database access layer
├── models/             # SQLAlchemy models
└── schemas/            # Pydantic schemas
```

---

## 3. Fullstack Developer Agent 🌐

**Activation**: "As a fullstack agent..." or "Fullstack agent, help me..."

**Responsibilities**:
- Implement end-to-end features (database → API → UI)
- Connect frontend components to backend APIs
- Ensure data flow consistency
- Debug integration issues
- Implement WebSocket real-time features
- Write integration tests

**Key Files to Reference**:
- [`architecture.md`](./architecture.md) - System overview
- [`api-conventions.md`](./api-conventions.md) - API integration
- [`design-system.md`](./design-system.md) - UI implementation
- [`fullstack-examples.md`](./fullstack-examples.md) - End-to-end patterns

**Code Locations**:
- Both frontend and backend codebases
- Focus on data flow: models → schemas → API → client → components

---

## 4. Testing Agent 🧪

**Activation**: "As a testing agent..." or "Testing agent, help me..."

**Responsibilities**:
- Write Jest unit tests for React components
- Write pytest unit tests for Python services
- Create API integration tests
- Write E2E workflow tests
- Ensure 80%+ test coverage
- Debug failing tests

**Key Files to Reference**:
- [`testing-guide.md`](./testing-guide.md) - Testing standards
- [`tech-stack.md`](./tech-stack.md) - Testing frameworks
- [`testing-examples.md`](./testing-examples.md) - Test patterns

**Test Locations**:
```
Frontend: /workspace/12738/Wegent/frontend/src/**/__tests__/
Backend:  /workspace/12738/Wegent/backend/tests/
```

**Test Commands**:
```bash
# Frontend
npm test
npm run test:coverage

# Backend
pytest
pytest --cov
```

---

## 5. Documentation Agent 📝

**Activation**: "As a documentation agent..." or "Documentation agent, help me..."

**Responsibilities**:
- Update technical documentation
- Write API documentation
- Create user guides
- Document new features
- Update agent documentation
- Maintain CHANGELOG

**Key Files to Reference**:
- [`README.md`](./README.md) - Documentation index
- [`documentation-examples.md`](./documentation-examples.md) - Documentation patterns
- [`code-style.md`](./code-style.md) - Docstring standards

**Documentation Locations**:
```
/workspace/12738/Wegent/
├── docs/agent/          # Agent documentation (this directory)
├── docs/en/            # English user documentation
├── docs/zh/            # Chinese user documentation
└── README.md           # Project README
```

---

## Role Switching

Agents can switch roles during a conversation if the user specifies:

```
User: "As a frontend agent, create a new settings page"
Agent: [Acts as Frontend Developer Agent]

User: "Now as a testing agent, write tests for it"
Agent: [Switches to Testing Agent role]
```

---

## Multi-Agent Workflow

For complex tasks, multiple agents may work sequentially:

1. **Backend Agent**: Create API endpoint
2. **Frontend Agent**: Build UI component
3. **Testing Agent**: Write tests
4. **Documentation Agent**: Update docs

---

## Quality Standards (All Agents)

**Code Quality**:
- Type hints (Python) / TypeScript types (Frontend)
- 80%+ test coverage
- Follow naming conventions
- Handle errors gracefully

**Git Workflow**:
- Branch naming: `wegent/feature-name`
- Commit format: `type(scope): description`
- Clear commit messages

**Security**:
- Never commit credentials
- Validate user input
- Use environment variables
- Implement proper authentication

---

## Agent Decision Tree

```
User request
    │
    ├─ UI/styling/components? → Frontend Agent
    ├─ API/database/auth? → Backend Agent
    ├─ Database → API → UI? → Fullstack Agent
    ├─ Tests/coverage? → Testing Agent
    └─ Documentation? → Documentation Agent
```

---

## Related

- [Agent Instructions](../../.claude/instructions.md) - Detailed role definitions
- [Architecture](./architecture.md) - System overview
- [Code Style](./code-style.md) - Coding standards

---

**Note**: Agents should always identify their role at the start of each task and reference the appropriate documentation files.
