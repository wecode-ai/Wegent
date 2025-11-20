# 👻 Creating Ghosts

Ghost is the "soul" of an agent in Wegent, defining the agent's personality, expertise, and tool capabilities. This guide will help you create powerful Ghost configurations.

---

## 📋 Table of Contents

- [What is a Ghost](#-what-is-a-ghost)
- [Core Concepts](#-core-concepts)
- [Creation Steps](#-creation-steps)
- [Configuration Details](#-configuration-details)
- [Practical Examples](#-practical-examples)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Ghost

Ghost is the core definition of an agent, similar to a person's "personality" and "skills". A Ghost contains:

- **System Prompt**: Defines the agent's role, expertise, and behavioral guidelines
- **MCP Server Configuration**: Grants the agent access to external tools (like GitHub, filesystem, etc.)

**Analogy**: If a Bot is a person, Ghost is that person's soul, personality, and professional skills.

---

## 🧩 Core Concepts

### Components of a Ghost

```
Ghost = System Prompt + MCP Tool Configuration
```

- **System Prompt**: Tells the AI "who you are" and "what you're good at"
- **MCP Servers**: Provides actual tool capabilities (API calls, file operations, etc.)

### Ghost vs Bot

| Concept | Description | Analogy |
|---------|-------------|---------|
| Ghost | Agent's "soul" | Person's personality and skills |
| Bot | Complete agent instance | Complete person (soul + body + brain) |

---

## 🚀 Creation Steps

### Step 1: Define Ghost's Purpose

Before creating a Ghost, clarify these questions:

- What role will this agent play?
- What expertise is needed?
- What tools are required?

**Examples**:
- Frontend Developer Ghost: Expert in React/TypeScript
- Code Reviewer Ghost: Focused on code quality and best practices
- Test Engineer Ghost: Specialized in test case writing

### Step 2: Write System Prompt

System prompt should include:

1. **Role Definition**: Clearly state the agent's identity
2. **Expertise**: List technical stack proficiency
3. **Working Style**: Explain how to complete tasks
4. **Guidelines**: Special points to note

**Example Prompt Structure**:
```
You are a [role], skilled in [skill list].

Your responsibilities:
- [Responsibility 1]
- [Responsibility 2]
- [Responsibility 3]

When working, you should:
- [Guideline 1]
- [Guideline 2]
```

### Step 3: Configure MCP Servers

Configure necessary MCP tools based on Ghost's needs:

**Common MCP Servers**:
- **GitHub MCP**: Code repository operations
- **Filesystem MCP**: File read/write
- **Database MCP**: Database access
- **Custom MCP**: Custom tools

### Step 4: Write YAML Configuration

Combine the above into standard YAML format.

### Step 5: Deploy and Test

Deploy Ghost through Wegent platform and test via Bot.

---

## 📝 Configuration Details

### Basic Configuration Structure

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: <ghost-name>
  namespace: default
spec:
  systemPrompt: |
    <system-prompt>
  mcpServers:
    <server-name>:
      command: <command>
      args:
        - <argument>
      env:
        <env-var-name>: <env-var-value>
```

### Field Descriptions

#### metadata Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier for Ghost, use lowercase and hyphens |
| `namespace` | string | Yes | Namespace, typically `default` |

#### spec Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `systemPrompt` | string | Yes | System prompt defining agent's personality and capabilities |
| `mcpServers` | object | No | MCP server configuration object |

#### mcpServers Configuration

Each MCP server includes:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Launch command (e.g., `docker`, `npx`) |
| `args` | array | Yes | Command argument list |
| `env` | object | No | Environment variable configuration |

---

## 💡 Practical Examples

### Example 1: Frontend Developer Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: frontend-developer-ghost
  namespace: default
spec:
  systemPrompt: |
    You are a senior frontend engineer, proficient in the following tech stack:
    - React 18+ and TypeScript
    - Tailwind CSS and modern CSS
    - Vite and modern build tools
    - Frontend performance optimization and best practices

    Your responsibilities:
    - Develop high-quality frontend components and pages
    - Write clean, maintainable code
    - Follow React and TypeScript best practices
    - Ensure code has good type safety

    Working principles:
    - Prioritize functional components and Hooks
    - Write TypeScript types for all components
    - Follow component-based and modular design principles
    - Focus on user experience and interface aesthetics

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### Example 2: Code Reviewer Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: code-reviewer-ghost
  namespace: default
spec:
  systemPrompt: |
    You are an experienced code review expert, focused on code quality and best practices.

    Review focus:
    - Code readability and maintainability
    - Potential bugs and security issues
    - Performance optimization opportunities
    - Adherence to project standards and best practices
    - Test coverage and test quality

    Review principles:
    - Provide constructive feedback
    - Explain the reasons for issues and improvement solutions
    - Prioritize critical issues
    - Acknowledge good code design

    Output format:
    - Use clear categories (Critical/General/Suggestion)
    - Provide specific code examples
    - Give improvement suggestions and best practices

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - -e
        - GITHUB_READ_ONLY
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
        GITHUB_READ_ONLY: "true"
```

### Example 3: Test Engineer Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: test-engineer-ghost
  namespace: default
spec:
  systemPrompt: |
    You are a professional test engineer, proficient in automated testing and quality assurance.

    Technical expertise:
    - Jest/Vitest unit testing frameworks
    - React Testing Library
    - Playwright/Cypress E2E testing
    - Test-Driven Development (TDD)

    Work responsibilities:
    - Write comprehensive test cases for new features
    - Ensure test coverage meets standards (>80%)
    - Write clear test documentation
    - Discover and report potential issues

    Testing principles:
    - Tests should be simple, clear, and easy to maintain
    - Follow AAA pattern (Arrange-Act-Assert)
    - Test cases should be independent and repeatable
    - Prioritize testing critical paths and edge cases

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### Example 4: Python Backend Developer Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: python-backend-ghost
  namespace: default
spec:
  systemPrompt: |
    You are a senior Python backend engineer, skilled in building high-performance backend services.

    Tech stack:
    - Python 3.10+ and modern Python features
    - FastAPI/Django frameworks
    - SQLAlchemy ORM
    - PostgreSQL/MySQL databases
    - Redis caching
    - Docker containerization

    Responsibilities:
    - Design and implement RESTful APIs
    - Write high-quality, type-safe Python code
    - Optimize database queries and performance
    - Implement secure authentication and authorization

    Coding standards:
    - Follow PEP 8 code style
    - Use Type Hints for type safety
    - Write clear Docstrings
    - Proper error handling and logging

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### Example 5: Documentation Writer Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: documentation-writer-ghost
  namespace: default
spec:
  systemPrompt: |
    You are a professional technical documentation writer, skilled in writing clear and understandable technical docs.

    Expertise:
    - API documentation writing
    - User guides and tutorials
    - Architecture design documents
    - README and developer documentation

    Writing principles:
    - Use clear and concise language
    - Provide practical code examples
    - Organize content with structure
    - Consider readers with different technical backgrounds

    Document structure:
    - Clear heading hierarchy
    - Table of contents navigation
    - Code examples and screenshots
    - FAQ section
    - Related resource links

    Output format:
    - Use Markdown format
    - Appropriate use of tables and lists
    - Add icons and visual elements
    - Maintain style consistency

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

---

## ✨ Best Practices

### 1. System Prompt Design

#### ✅ Recommended Approach

- **Clear and Specific**: Clearly define role and responsibilities
- **Structured**: Use lists and paragraphs to organize content
- **Include Constraints**: State what should and shouldn't be done
- **Provide Examples**: Include expected output format in prompt

**Good Example**:
```yaml
systemPrompt: |
  You are a React development engineer, focused on:
  - Component development
  - Performance optimization
  - Type safety

  You should:
  - Use functional components
  - Write TypeScript types
  - Follow React best practices
```

#### ❌ What to Avoid

- **Too Broad**: "You are a developer" (too vague)
- **Lack of Focus**: Listing too many unrelated skills
- **No Guidance**: Not explaining how to complete tasks
- **Too Lengthy**: Prompts exceeding 1000 words

### 2. MCP Server Configuration

#### ✅ Recommended Approach

- **Configure as Needed**: Only add truly necessary MCP servers
- **Environment Variables**: Use environment variables for sensitive information
- **Minimize Permissions**: Grant only necessary permissions (e.g., use `READ_ONLY` mode)

**Example**:
```yaml
mcpServers:
  github:
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
      GITHUB_READ_ONLY: "true"  # Read-only mode, more secure
```

#### ❌ What to Avoid

- **Too Many Tools**: Adding unnecessary MCP servers
- **Hardcoded Credentials**: Writing tokens directly in YAML
- **Over-Authorization**: Granting permissions beyond requirements

### 3. Naming Conventions

#### ✅ Recommended Approach

- Use descriptive names: `frontend-developer-ghost`
- Lowercase and hyphens: `code-reviewer-ghost`
- Include role info: `python-backend-ghost`

#### ❌ What to Avoid

- Vague names: `ghost1`, `my-ghost`
- Special characters: `ghost_v2`, `ghost@dev`
- Uppercase letters: `FrontendGhost`

### 4. Reusability and Modularity

Create reusable Ghosts:

```yaml
# Base developer Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: base-developer-ghost
  namespace: default
spec:
  systemPrompt: |
    You are a software engineer, following these general principles:
    - Write clean, maintainable code
    - Follow project standards
    - Focus on code quality
```

Then customize in Bot through additional prompts:

```yaml
# Add specific prompts in Team for members
members:
  - name: "frontend-dev"
    botRef:
      name: base-developer-bot  # Use base Bot
    prompt: "Focus on React frontend development"  # Add specific responsibilities
```

### 5. Version Management

Use clear naming for different versions of Ghost:

```yaml
# Development version
name: frontend-dev-ghost-v1

# Production version
name: frontend-prod-ghost-v1
```

---

## ⚠️ Common Issues

### Q1: How to test Ghost after creation?

**Answer**: After creating Ghost, you need to:

1. Create corresponding Bot (associate Ghost + Shell + Model)
2. Create Team containing that Bot
3. Create Task for testing

**Example flow**:
```
Ghost → Bot → Team → Task (test)
```

### Q2: How long can the system prompt be?

**Answer**: Recommended to keep within 500-1000 words. Too long prompts may:
- Affect response speed
- Distract AI attention
- Increase token consumption

### Q3: Can multiple MCP servers be configured simultaneously?

**Answer**: Yes! A Ghost can configure multiple MCP servers:

```yaml
mcpServers:
  github:
    command: docker
    args: [...]
  filesystem:
    command: npx
    args: [...]
  database:
    command: docker
    args: [...]
```

### Q4: Do Bots need to restart after Ghost modification?

**Answer**: Yes. Ghost modifications don't automatically apply to running Bots. You need to:

1. Update Ghost configuration
2. Restart or recreate Bots using that Ghost
3. Redeploy related Teams

### Q5: How to add custom MCP server to Ghost?

**Answer**: You can configure custom MCP servers:

```yaml
mcpServers:
  custom-api:
    command: docker
    args:
      - run
      - -i
      - --rm
      - -e
      - API_KEY
      - your-custom-mcp-image:latest
    env:
      API_KEY: ${CUSTOM_API_KEY}
```

### Q6: Can Ghost be reused by multiple Bots?

**Answer**: Yes! This is the recommended approach:

```yaml
# One Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
---
# Multiple Bots can reference the same Ghost
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: bot-1
spec:
  ghostRef:
    name: developer-ghost  # Reuse
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: bot-2
spec:
  ghostRef:
    name: developer-ghost  # Reuse
```

### Q7: How to manage sensitive information (like API tokens)?

**Answer**: Use environment variables instead of hardcoding:

```yaml
# ❌ Bad practice
env:
  GITHUB_PERSONAL_ACCESS_TOKEN: ghp_xxxxxxxxxxxx

# ✅ Good practice
env:
  GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

Configure actual environment variable values through the platform during deployment.

### Q8: What's the difference between Ghost and Model?

**Answer**:

| Concept | Purpose | Analogy |
|---------|---------|---------|
| Ghost | Defines agent's personality and capabilities | Person's character and skills |
| Model | Defines AI model configuration | Person's "brain" configuration |

Ghost defines "what to do", Model defines "which brain to use".

---

## 🎓 Advanced Tips

### Tip 1: Use Context Prompts

Provide project context in system prompt:

```yaml
systemPrompt: |
  You are a frontend developer for the Wegent project.

  Project context:
  - Tech stack: React 18 + TypeScript + Tailwind CSS
  - Code standards: ESLint + Prettier
  - Component library: Shadcn UI
  - State management: Zustand

  You need to follow the project's existing style and standards.
```

### Tip 2: Define Output Format

Explicitly specify expected output format:

```yaml
systemPrompt: |
  You are a code review expert.

  Please provide review results in the following format:

  ## 🔴 Critical Issues
  - [filename:line] Issue description

  ## 🟡 General Issues
  - [filename:line] Issue description

  ## 💡 Suggestions
  - [filename:line] Improvement suggestion
```

### Tip 3: Set Role Limitations

Clearly state what the agent shouldn't do:

```yaml
systemPrompt: |
  You are a documentation writer.

  You should:
  - Write clear documentation
  - Provide code examples

  You should NOT:
  - Modify source code
  - Execute code
  - Access sensitive information
```

### Tip 4: Multi-language Support

Create multi-language Ghosts for international projects:

```yaml
# Chinese documentation Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: doc-writer-zh-ghost
spec:
  systemPrompt: |
    你是中文技术文档撰写者...
---
# English documentation Ghost
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: doc-writer-en-ghost
spec:
  systemPrompt: |
    You are a technical documentation writer...
```

---

## 📊 Complete Example: Full-Stack Development Team Ghosts

### 1. Frontend Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: fullstack-frontend-ghost
  namespace: default
spec:
  systemPrompt: |
    You are the frontend lead of a full-stack development team.

    Tech stack: React + TypeScript + Vite + Tailwind CSS

    Responsibilities:
    - Develop responsive UI components
    - Implement frontend routing and state management
    - Integrate with backend APIs
    - Optimize frontend performance

    Workflow:
    1. Analyze requirements, design component structure
    2. Write type-safe code
    3. Write unit tests
    4. Submit code and create PR

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### 2. Backend Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: fullstack-backend-ghost
  namespace: default
spec:
  systemPrompt: |
    You are the backend lead of a full-stack development team.

    Tech stack: FastAPI + Python + PostgreSQL + Redis

    Responsibilities:
    - Design and implement RESTful APIs
    - Database design and optimization
    - Implement business logic
    - Write API documentation

    Workflow:
    1. Design API interfaces
    2. Implement data models and business logic
    3. Write API tests
    4. Update API documentation

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

### 3. DevOps Ghost

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: fullstack-devops-ghost
  namespace: default
spec:
  systemPrompt: |
    You are the DevOps engineer of a full-stack development team.

    Tech stack: Docker + Kubernetes + GitHub Actions + Terraform

    Responsibilities:
    - Configure CI/CD pipelines
    - Manage containerized deployments
    - Monitor system performance
    - Optimize deployment processes

    Focus areas:
    - Automate everything that can be automated
    - Ensure deployment reliability and security
    - Write clear deployment documentation

  mcpServers:
    github:
      command: docker
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - ghcr.io/github/github-mcp-server
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
```

---

## 🔗 Related Resources

### Core Documentation
- [Core Concepts](../../concepts/core-concepts.md) - Understand Ghost's role in Wegent
- [YAML Specification](../../reference/yaml-specification.md) - Complete YAML configuration format

### Next Steps
- [Creating Bots](./creating-bots.md) - Assemble Ghost into complete Bot
- [Creating Teams](./creating-teams.md) - Build multi-Bot collaboration teams
- [Managing Tasks](./managing-tasks.md) - Assign tasks to Teams

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions

---

<p align="center">Create your first Ghost and begin your AI agent journey! 🚀</p>
