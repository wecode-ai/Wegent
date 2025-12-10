# 🎯 Managing Tasks

Task is an executable work unit in Wegent that assigns user requirements to Teams or Bots for execution. This guide will teach you how to create, manage, and monitor tasks.

---

## 📋 Table of Contents

- [What is a Task](#-what-is-a-task)
- [Core Concepts](#-core-concepts)
- [Creation Steps](#-creation-steps)
- [Configuration Details](#-configuration-details)
- [Task Lifecycle](#-task-lifecycle)
- [Practical Examples](#-practical-examples)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Task

Task is the bridge between user requirements and AI agents, defining "what to do" and "who does it".

**Analogy**:
```
Real World                →  Wegent
-------------------      →  -------------------
Work order               →  Task
Assign to team           →  teamRef
Execute in project       →  workspaceRef
Task description         →  prompt
```

### Task Composition

```
Task = Task Description + Execution Team + Workspace + Status Tracking
```

---

## 🧩 Core Concepts

### Four Elements of Task

| Element | Description | Example |
|---------|-------------|---------|
| **Prompt** | Task description and requirements | "Implement user login feature" |
| **Team** | Team executing the task | fullstack-dev-team |
| **Workspace** | Working environment and code repository | project-workspace |
| **Status** | Task execution status | PENDING → RUNNING → COMPLETED |

### Task vs Team

| Concept | Description | Nature |
|---------|-------------|--------|
| **Team** | Agent team definition | Static resource |
| **Task** | Work assigned to Team | Dynamic execution unit |

**Relationship**:
```
Team (definition) + Task (work) = Actual execution
```

---

## 🚀 Creation Steps

### Step 1: Prepare Prerequisites

Before creating Task, ensure these resources are prepared:

**Required resources**:
- ✅ **Team**: Already created and status is Available
- ✅ **Workspace**: Code repository information configured

**Checklist**:
```bash
# Check if Team is available
kubectl get team <team-name> -n default

# Check if Workspace is configured
kubectl get workspace <workspace-name> -n default
```

### Step 2: Clarify Task Requirements

Clearly define specific task requirements:

**Good task description**:
- ✅ Specific and clear
- ✅ Include acceptance criteria
- ✅ State technical requirements
- ✅ Provide necessary context

**Example**:
```
✅ Good: "Implement user login page using React and TypeScript,
      including email and password input fields, form validation,
      and login API call. Need to write unit tests with >80% coverage."

❌ Bad: "Make a login feature"
```

### Step 3: Choose Appropriate Team

Select corresponding Team based on task type:

| Task Type | Recommended Team |
|-----------|------------------|
| Full-stack dev | fullstack-dev-team |
| Frontend dev | frontend-team |
| Code review | code-review-team |
| Bug fix | bugfix-team |
| Documentation | documentation-team |

### Step 4: Configure Workspace

Select or create appropriate Workspace:

```yaml
# Ensure Workspace points to correct repository and branch
apiVersion: agent.wecode.io/v1
kind: Workspace
metadata:
  name: my-project-workspace
spec:
  repository:
    gitUrl: "https://github.com/user/repo.git"
    gitRepo: "user/repo"
    branchName: "main"
    gitDomain: "github.com"
```

### Step 5: Create Task Configuration

Write Task's YAML configuration.

### Step 6: Submit and Monitor

Submit Task and continuously monitor execution status.

---

## 📝 Configuration Details

### Basic Configuration Structure

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: <task-name>
  namespace: default
spec:
  title: <task-title>
  prompt: <detailed-task-description>
  teamRef:
    name: <team-name>
    namespace: default
  workspaceRef:
    name: <workspace-name>
    namespace: default
status:
  state: "Available"
  status: "PENDING"
  progress: 0
  result: null
  errorMessage: null
```

### Field Descriptions

#### metadata Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Task's unique identifier |
| `namespace` | string | Yes | Namespace, typically `default` |

#### spec Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Task title (brief description) |
| `prompt` | string | Yes | Detailed task description and requirements |
| `teamRef` | object | Yes | Team reference executing the task |
| `workspaceRef` | object | Yes | Workspace reference |
| `model_id` | string | No | Model name to override Bot's default model |
| `force_override_bot_model` | boolean | No | Force use of specified model even if Bot has configured model |

### Per-Task Model Selection

When creating a task through the Web interface, you can select a different model:

1. **Model Selector**: In the chat input area, use the model dropdown to select from available models
2. **Force Override**: Enable this option to ensure your selected model is used regardless of Bot configuration

**Use cases**:
- Test different models without modifying Bot configuration
- Use a more powerful model for complex one-off tasks
- Use a cheaper/faster model for simple queries

### Web Search & Search Engine

When using a Chat Shell and web search is enabled in the system:

1. **Web Search Toggle**: Click the globe icon to enable or disable web search capability.
2. **Search Engine Selector**: Select your preferred search engine (e.g., Google, Bing) from the dropdown menu.

#### status Section

| Field | Type | Description |
|-------|------|-------------|
| `state` | string | Resource state: `Available`, `Unavailable` |
| `status` | string | Execution status: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `progress` | number | Progress percentage (0-100) |
| `result` | string | Task execution result |
| `errorMessage` | string | Error message (if failed) |

### Task Status Details

| Status | Description | Next Step |
|--------|-------------|-----------|
| `PENDING` | Waiting for execution | System will automatically start |
| `RUNNING` | Currently executing | Monitor progress and logs |
| `COMPLETED` | Successfully completed | Review results, accept |
| `FAILED` | Execution failed | Check errors, fix and retry |
| `CANCELLED` | Cancelled | Recreate if needed |

---

## 🔄 Task Lifecycle

### Standard Flow

```
1. PENDING (created)
   ↓
2. RUNNING (executing)
   ↓
3. COMPLETED (success)
   or
   FAILED (failure)
   or
   CANCELLED (cancelled)
```

### Detailed Stages

#### Stage 1: Creation (PENDING)

```yaml
# Submit Task
kubectl apply -f task.yaml

# Status: PENDING
status:
  status: "PENDING"
  progress: 0
```

#### Stage 2: Execution (RUNNING)

```yaml
# System automatically starts execution
status:
  status: "RUNNING"
  progress: 50  # Progress updated
```

**Execution process**:
1. Wegent creates Team instance
2. Assigns Workspace
3. Team members start collaborating
4. Continuously updates progress

#### Stage 3: Completion (COMPLETED)

```yaml
# Task successfully completed
status:
  status: "COMPLETED"
  progress: 100
  result: |
    Task completed!
    - Created new branch: feature/user-login
    - Submitted 5 commits
    - Created Pull Request #123
```

#### Stage 4: Failure (FAILED)

```yaml
# Task execution failed
status:
  status: "FAILED"
  progress: 60
  errorMessage: "Compilation error: TypeScript type checking failed"
```

#### Stage 5: Cancellation (CANCELLED)

```yaml
# User actively cancelled
status:
  status: "CANCELLED"
  progress: 30
```

---

## 💡 Practical Examples

### Example 1: Implement New Feature

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: implement-user-login
  namespace: default
spec:
  title: "Implement User Login Feature"

  prompt: |
    Please implement complete user login functionality, including:

    ## Feature Requirements
    1. User login page (React + TypeScript)
       - Email input field (with validation)
       - Password input field (hide/show toggle)
       - Remember me option
       - Login button

    2. Frontend logic
       - Form validation (email format, password length)
       - Call login API
       - Handle success/failure responses
       - Save Token to localStorage

    3. Backend API (FastAPI)
       - POST /api/auth/login
       - Validate user credentials
       - Generate JWT Token
       - Return user information

    4. Testing
       - Frontend unit tests (coverage >80%)
       - API integration tests
       - E2E tests

    ## Technical Requirements
    - Frontend: React 18, TypeScript, Tailwind CSS
    - Backend: FastAPI, SQLAlchemy, JWT
    - Follow existing project code standards

    ## Acceptance Criteria
    - All tests pass
    - Code review approved
    - Functionality verified in test environment

  teamRef:
    name: fullstack-dev-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default

status:
  state: "Available"
  status: "PENDING"
```

### Example 2: Bug Fix

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: fix-login-redirect-bug
  namespace: default
spec:
  title: "Fix Login Redirect Failure Bug"

  prompt: |
    ## Bug Description
    After successful login, user should be redirected to dashboard (/dashboard),
    but actually stays on login page without redirect.

    ## Reproduction Steps
    1. Visit login page /login
    2. Enter valid email and password
    3. Click login button
    4. Login succeeds but page doesn't redirect

    ## Expected Behavior
    After successful login, should automatically redirect to /dashboard

    ## Environment Info
    - Browser: Chrome 120
    - Branch: main
    - Related code: src/pages/Login.tsx

    ## Debug Suggestions
    1. Check React Router configuration
    2. Review login success callback function
    3. Check for error logs
    4. Verify Token save success

    ## Acceptance Criteria
    - Bug fixed
    - Added tests to prevent regression
    - Verified fix in development environment

  teamRef:
    name: bugfix-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

### Example 3: Code Review

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: review-pr-123
  namespace: default
spec:
  title: "Review Pull Request #123"

  prompt: |
    Please review Pull Request #123: "Add user profile page"

    ## Review Focus
    1. Code quality
       - Follows project standards
       - Clear and reasonable naming
       - Code duplication

    2. Feature implementation
       - Meets requirements
       - Edge case handling
       - Complete error handling

    3. Testing
       - Adequate test coverage
       - Reasonable test cases
       - Integration tests present

    4. Performance and security
       - Performance issues
       - Security vulnerabilities
       - Optimized API calls

    5. Documentation
       - Documentation updates needed
       - Clear code comments
       - README updates needed

    ## Output Format
    Please provide review feedback in this format:

    ### ✅ Strengths
    - ...

    ### 🔴 Critical Issues (must fix)
    - ...

    ### 🟡 General Issues (recommend fixing)
    - ...

    ### 💡 Suggestions
    - ...

  teamRef:
    name: code-review-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

### Example 4: Performance Optimization

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: optimize-dashboard-performance
  namespace: default
spec:
  title: "Optimize Dashboard Page Performance"

  prompt: |
    ## Background
    Dashboard page loading time is too long (>5s), poor user experience,
    needs performance optimization.

    ## Current Performance Metrics
    - First Contentful Paint (FCP): 3.2s
    - Largest Contentful Paint (LCP): 5.8s
    - First Input Delay (FID): 280ms
    - Cumulative Layout Shift (CLS): 0.15

    ## Optimization Goals
    - FCP < 1.5s
    - LCP < 2.5s
    - FID < 100ms
    - CLS < 0.1

    ## Optimization Directions
    1. Code level
       - Use React.memo to reduce unnecessary re-renders
       - Implement virtual scrolling for long lists
       - Lazy load non-critical components
       - Optimize state management

    2. Resource level
       - Image optimization and lazy loading
       - Code splitting and on-demand loading
       - Compress and cache static resources

    3. Data level
       - Optimize API calls
       - Implement data pagination
       - Add caching strategy

    ## Acceptance Criteria
    - Performance metrics meet goals
    - Lighthouse score >90
    - No impact on existing features
    - Add performance monitoring

  teamRef:
    name: performance-optimization-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

### Example 5: Documentation Writing

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: write-api-documentation
  namespace: default
spec:
  title: "Write API Documentation"

  prompt: |
    Please write complete documentation for the project's REST API.

    ## Documentation Requirements
    1. API Overview
       - Base URL
       - Authentication method
       - Common request/response format
       - Error code descriptions

    2. Endpoint Documentation
       For each API endpoint provide:
       - Endpoint path and method
       - Request parameters (path/query/body)
       - Response format and examples
       - Possible error codes
       - Code examples (curl, JavaScript)

    3. Authentication and Authorization
       - How to obtain Token
       - Token usage method
       - Permission descriptions

    4. Best Practices
       - Rate limiting explanation
       - Caching strategy
       - Version control

    ## Format Requirements
    - Use Markdown format
    - Clear directory structure
    - Include actually runnable examples
    - Add OpenAPI/Swagger specification

    ## Output Location
    - Main documentation: docs/api/README.md
    - OpenAPI specification: docs/api/openapi.yaml

  teamRef:
    name: documentation-team
    namespace: default

  workspaceRef:
    name: main-project-workspace
    namespace: default
```

---

## ✨ Best Practices

### 1. Task Description Writing

#### ✅ Recommended: SMART Principles

- **S**pecific: Clearly state what to do
- **M**easurable: Have clear acceptance criteria
- **A**chievable: Reasonable task scope
- **R**elevant: Related to project goals
- **T**ime-bound: Clear expected completion time

**Good example**:
```yaml
prompt: |
  Implement user registration API:
  - POST /api/auth/register
  - Accept email, password, username
  - Validate email format and password strength
  - Save user to database
  - Return user info and Token
  - Write unit tests (coverage >80%)
  - Update API documentation
```

#### ❌ Avoid: Vague Description

```yaml
prompt: "Make a registration feature"  # Too simple
prompt: "Optimize the system"  # Too broad
```

### 2. Task Granularity

#### ✅ Recommended: Moderate Task Granularity

```yaml
# Good - Single feature
title: "Implement user login page"

# Good - Single bug fix
title: "Fix login redirect issue"

# Bad - Too large
title: "Develop entire user management system"

# Bad - Too small
title: "Rename one variable"
```

**Recommended granularity**:
- Small task: 1-2 hours
- Medium task: 4-8 hours
- Large task: 1-2 days

### 3. Context Information

#### ✅ Provide Sufficient Context

```yaml
prompt: |
  ## Background
  Project uses FastAPI + React tech stack...

  ## Current Implementation
  Current login uses basic auth, need to upgrade to JWT...

  ## Related Code
  - Backend: src/api/auth.py
  - Frontend: src/pages/Login.tsx

  ## Dependencies
  Need to install python-jose library...

  ## Reference
  See similar implementation at /api/refresh-token
```

### 4. Acceptance Criteria

#### ✅ Clear Acceptance Criteria

```yaml
prompt: |
  ...

  ## Acceptance Criteria
  - [ ] All unit tests pass
  - [ ] Integration tests pass
  - [ ] Code review approved
  - [ ] Verified in test environment
  - [ ] Performance tests meet standards
  - [ ] Documentation updated
```

### 5. Task Monitoring

#### ✅ Regularly Check Task Status

```bash
# View task status
kubectl get task <task-name> -n default

# View detailed information
kubectl describe task <task-name> -n default

# View execution logs
kubectl logs <task-pod> -n default
```

### 6. Error Handling

#### Task Failure Handling Flow

```
1. View error message
   kubectl describe task <task-name>

2. Analyze failure reason
   - Configuration error?
   - Team unavailable?
   - Unclear task description?

3. Fix issue
   - Update configuration
   - Fix Team
   - Optimize prompt

4. Recreate task
   kubectl delete task <task-name>
   kubectl apply -f task-fixed.yaml
```

### 7. Cost Optimization

#### Strategy 1: Choose Team Appropriately

```yaml
# Simple task - Use small team
teamRef:
  name: solo-developer-team  # Only 1 Bot

# Complex task - Use full team
teamRef:
  name: fullstack-dev-team  # Multiple Bots collaborate
```

#### Strategy 2: Task Splitting

```yaml
# Bad - One large task
title: "Develop entire e-commerce system"

# Good - Split into multiple small tasks
---
title: "Implement product list page"
---
title: "Implement shopping cart feature"
---
title: "Implement order system"
```

---

## ⚠️ Common Issues

### Q1: Task stuck in PENDING status?

**Possible reasons**:
1. Team unavailable
2. Workspace configuration error
3. Insufficient system resources

**Solutions**:
```bash
# 1. Check Team status
kubectl get team <team-name> -n default

# 2. Check Workspace status
kubectl get workspace <workspace-name> -n default

# 3. View Task details
kubectl describe task <task-name> -n default

# 4. View system logs
kubectl logs -n wegent-system <executor-pod>
```

### Q2: What to do when Task execution fails?

**Answer**: Follow these troubleshooting steps:

```
1. View error message
   status.errorMessage field

2. Check task description
   Is it clear and specific?

3. Verify Team capability
   Does Team have ability to complete task?

4. Check Workspace
   Is code repository accessible?

5. Retry
   Recreate Task after fixing issues
```

### Q3: How to cancel running Task?

**Answer**:
```bash
# Method 1: Via kubectl
kubectl patch task <task-name> -n default \
  -p '{"status":{"status":"CANCELLED"}}'

# Method 2: Via API
curl -X PATCH /api/tasks/<task-id> \
  -d '{"status":"CANCELLED"}'
```

### Q4: Can Task be paused?

**Answer**: Wegent currently doesn't support task pause, can only:
- Cancel task
- Create new task after completion

### Q5: How to view Task execution logs?

**Answer**:
```bash
# Method 1: View Task details
kubectl describe task <task-name> -n default

# Method 2: View executor logs
kubectl logs <executor-pod> -n wegent-system -f

# Method 3: Via Web UI
Visit Wegent UI to view task details page
```

### Q6: How to accept Task after completion?

**Answer**: Acceptance checklist:

```
✅ Check task status
   status.status == "COMPLETED"

✅ View execution results
   status.result contains completion info

✅ Verify code changes
   - Review Git commits
   - Review Pull Request
   - Run tests

✅ Functional verification
   - Verify in test environment
   - Check if meets requirements

✅ Quality check
   - Code quality
   - Test coverage
   - Documentation updates
```

### Q7: How to estimate Task cost?

**Answer**: Cost depends on multiple factors:

```
Task cost = Number of Team members × Model cost × Execution time

Influencing factors:
- Team size
- Model type used (Haiku/Sonnet/Opus)
- Task complexity
- Execution duration

Optimization suggestions:
- Use appropriately sized Team
- Use Haiku for simple tasks
- Optimize task description to reduce execution time
```

### Q8: Can multiple Tasks run simultaneously?

**Answer**: Yes! Wegent supports concurrent execution of multiple Tasks:

```yaml
# Task 1
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: task-1
spec:
  teamRef:
    name: team-a
  # ...

# Task 2 (concurrent execution)
---
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: task-2
spec:
  teamRef:
    name: team-b
  # ...
```

**Note**: If Tasks operate on the same code repository, conflicts may occur.

---

## 🔗 Related Resources

### Prerequisites
- [Creating Ghosts](./creating-ghosts.md) - Define agent capabilities
- [Creating Bots](./creating-bots.md) - Assemble agent instances
- [Creating Teams](./creating-teams.md) - Build collaboration teams

### Reference Documentation
- [Core Concepts - Task](../../concepts/core-concepts.md#-task) - Understand Task's role
- [YAML Specification - Task](../../reference/yaml-specification.md#-task) - Complete configuration format

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions

---

<p align="center">Create your first Task and let the AI team work for you! 🚀</p>
