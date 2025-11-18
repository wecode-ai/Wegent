# 👥 Creating Teams

Team is a collaboration combination of multiple Bots in Wegent, implementing complex task division through different collaboration modes. This guide will teach you how to create efficient agent teams.

---

## 📋 Table of Contents

- [What is a Team](#-what-is-a-team)
- [Core Concepts](#-core-concepts)
- [Collaboration Modes](#-collaboration-modes)
- [Creation Steps](#-creation-steps)
- [Configuration Details](#-configuration-details)
- [Practical Examples](#-practical-examples)
- [Best Practices](#-best-practices)
- [Common Issues](#-common-issues)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Team

Team is a collaboration group composed of multiple Bots, just like a real software development team where each member has their own expertise and responsibilities.

**Analogy**:
```
Real Team                  →  AI Team
------------------------  →  ------------------------
Project Manager           →  Leader Bot
Frontend Engineer         →  Frontend Bot
Backend Engineer          →  Backend Bot
Test Engineer             →  Tester Bot
```

### Team Composition

```
Team = Multiple Bots + Collaboration Mode + Member Roles
```

---

## 🧩 Core Concepts

### Three Elements of Team

| Element | Description | Example |
|---------|-------------|---------|
| **Members** | List of Bots participating in collaboration | Frontend Bot, Backend Bot |
| **Roles** | Member roles in the team | Leader, Member |
| **Collaboration Mode** | Interaction method between Bots | Pipeline, Route, Coordinate |

### Role Types

| Role | Description | Responsibilities |
|------|-------------|------------------|
| **Leader** | Team leader | Coordinate, assign tasks, integrate results |
| **Member** | Regular member | Execute specific tasks |

---

## 🤝 Collaboration Modes

Wegent supports four collaboration modes, each suitable for different scenarios.

### 1. Pipeline Mode

**Characteristics**: Sequential execution, output of previous Bot becomes input of next Bot

**Flow**:
```
Bot A → Bot B → Bot C → Result
```

**Use cases**:
- Code development → Code review → Testing → Deployment
- Data collection → Data processing → Data analysis

**Example configuration**:
```yaml
spec:
  collaborationModel: "pipeline"
  members:
    - name: "developer"
      role: "member"
    - name: "reviewer"
      role: "member"
    - name: "tester"
      role: "member"
```

### 2. Route Mode

**Characteristics**: Leader routes tasks to appropriate Bot based on task type

**Flow**:
```
                → Frontend Bot (frontend tasks)
User Task → Leader
                → Backend Bot (backend tasks)
```

**Use cases**:
- Assign to different experts based on problem type
- Multi-domain support system

**Example configuration**:
```yaml
spec:
  collaborationModel: "route"
  members:
    - name: "coordinator"
      role: "leader"  # Leader handles routing
    - name: "frontend-expert"
      role: "member"
    - name: "backend-expert"
      role: "member"
```

### 3. Coordinate Mode

**Characteristics**: Leader coordinates multiple Bots working in parallel, then aggregates results

**Flow**:
```
          → Bot A (parallel)
Leader → → Bot B (parallel) → Leader (aggregate)
          → Bot C (parallel)
```

**Use cases**:
- Multi-perspective analysis
- Parallel task processing

**Example configuration**:
```yaml
spec:
  collaborationModel: "coordinate"
  members:
    - name: "coordinator"
      role: "leader"
    - name: "analyzer-1"
      role: "member"
    - name: "analyzer-2"
      role: "member"
```

### 4. Collaborate Mode

**Characteristics**: All Bots share context, freely discuss and collaborate

**Flow**:
```
Bot A ↔ Bot B ↔ Bot C (shared context, free interaction)
```

**Use cases**:
- Brainstorming
- Complex problem discussion
- Decisions requiring multiple opinions

**Example configuration**:
```yaml
spec:
  collaborationModel: "collaborate"
  members:
    - name: "expert-1"
      role: "member"
    - name: "expert-2"
      role: "member"
    - name: "expert-3"
      role: "member"
```

---

## 🚀 Creation Steps

### Step 1: Define Team Goals

Clarify what types of tasks the team will complete:

- Full-stack development?
- Code review and quality assurance?
- Data analysis?
- Documentation generation?

### Step 2: Choose Collaboration Mode

Select appropriate collaboration mode based on task characteristics:

| Task Type | Recommended Mode |
|-----------|------------------|
| Sequential workflow | Pipeline |
| Classification processing | Route |
| Parallel analysis | Coordinate |
| Discussion decisions | Collaborate |

### Step 3: Determine Team Members

Determine which specialized Bots are needed based on task requirements:

**Example - Full-stack dev team**:
- Frontend Developer Bot
- Backend Developer Bot
- Tester Bot
- Reviewer Bot

### Step 4: Assign Roles and Responsibilities

Assign roles to each member and write member prompts:

```yaml
members:
  - name: "developer"
    role: "leader"
    prompt: "You are responsible for overall development and coordination..."
  - name: "tester"
    role: "member"
    prompt: "You are responsible for writing test cases..."
```

### Step 5: Write YAML Configuration

Combine all information into Team configuration file.

### Step 6: Deploy and Test

Test Team's collaboration effectiveness through Tasks.

---

## 📝 Configuration Details

### Basic Configuration Structure

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: <team-name>
  namespace: default
spec:
  members:
    - name: <member-name>
      role: <member-role>
      botRef:
        name: <bot-name>
        namespace: default
      prompt: <member-specific-prompt>
  collaborationModel: <collaboration-mode>
status:
  state: "Available"
```

### Field Descriptions

#### metadata Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Team's unique identifier |
| `namespace` | string | Yes | Namespace, typically `default` |

#### spec Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `members` | array | Yes | Team member list |
| `collaborationModel` | string | Yes | Collaboration mode |

#### members Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Member name (unique within team) |
| `role` | string | No | Role: `leader` or `member` |
| `botRef` | object | Yes | Bot reference |
| `prompt` | string | No | Member-specific prompt |

#### collaborationModel Options

| Value | Description |
|-------|-------------|
| `pipeline` | Pipeline mode |
| `route` | Route mode |
| `coordinate` | Coordinate mode |
| `collaborate` | Collaborate mode |

---

## 💡 Practical Examples

### Example 1: Full-Stack Development Team (Pipeline Mode)

**Scenario**: Complete software development process

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: fullstack-dev-team
  namespace: default
spec:
  # Pipeline mode: Development → Review → Testing
  collaborationModel: "pipeline"

  members:
    # 1. Developer - Responsible for writing code
    - name: "developer"
      role: "member"
      botRef:
        name: fullstack-developer-bot
        namespace: default
      prompt: |
        You are the team developer, responsible for:
        - Analyzing requirements and designing solutions
        - Implementing frontend and backend features
        - Writing clear code comments
        - Committing code to Git repository

    # 2. Reviewer - Responsible for code review
    - name: "reviewer"
      role: "member"
      botRef:
        name: code-reviewer-bot
        namespace: default
      prompt: |
        You are the team code reviewer, responsible for:
        - Reviewing code quality and standards
        - Checking for potential bugs and security issues
        - Providing improvement suggestions
        - Ensuring code follows best practices

    # 3. Tester - Responsible for testing
    - name: "tester"
      role: "member"
      botRef:
        name: test-engineer-bot
        namespace: default
      prompt: |
        You are the team test engineer, responsible for:
        - Writing unit tests and integration tests
        - Ensuring test coverage meets standards
        - Running tests and reporting results
        - Verifying code quality

status:
  state: "Available"
```

**Workflow**:
```
1. Developer: Implement feature code
2. Reviewer: Review code quality
3. Tester: Write and run tests
4. Complete
```

### Example 2: Tech Support Team (Route Mode)

**Scenario**: Assign to different experts based on problem type

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: tech-support-team
  namespace: default
spec:
  # Route mode: Route based on problem type
  collaborationModel: "route"

  members:
    # Leader - Responsible for problem classification and routing
    - name: "support-coordinator"
      role: "leader"
      botRef:
        name: coordinator-bot
        namespace: default
      prompt: |
        You are the technical support coordinator, responsible for:
        - Analyzing user problem types
        - Routing frontend problems to frontend expert
        - Routing backend problems to backend expert
        - Routing database problems to database expert
        - Aggregating expert solutions

    # Frontend expert
    - name: "frontend-expert"
      role: "member"
      botRef:
        name: frontend-expert-bot
        namespace: default
      prompt: |
        You are a frontend technical expert, responsible for solving:
        - React/Vue related issues
        - CSS styling issues
        - Frontend performance issues
        - Browser compatibility issues

    # Backend expert
    - name: "backend-expert"
      role: "member"
      botRef:
        name: backend-expert-bot
        namespace: default
      prompt: |
        You are a backend technical expert, responsible for solving:
        - API design and implementation issues
        - Server performance issues
        - Business logic issues

    # Database expert
    - name: "database-expert"
      role: "member"
      botRef:
        name: database-expert-bot
        namespace: default
      prompt: |
        You are a database expert, responsible for solving:
        - SQL query optimization
        - Database design issues
        - Data migration issues

status:
  state: "Available"
```

### Example 3: Code Analysis Team (Coordinate Mode)

**Scenario**: Multi-perspective parallel code analysis

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: code-analysis-team
  namespace: default
spec:
  # Coordinate mode: Parallel analysis then aggregate
  collaborationModel: "coordinate"

  members:
    # Coordinator - Coordinate and aggregate
    - name: "analysis-coordinator"
      role: "leader"
      botRef:
        name: coordinator-bot
        namespace: default
      prompt: |
        You are the code analysis coordinator, responsible for:
        - Distributing code to different analyzers
        - Collecting results from each analyzer
        - Generating comprehensive analysis report
        - Prioritizing issues

    # Security analyzer
    - name: "security-analyzer"
      role: "member"
      botRef:
        name: security-bot
        namespace: default
      prompt: |
        Analyze code from security perspective:
        - Find security vulnerabilities
        - Check authentication/authorization issues
        - Identify sensitive information leaks
        - Provide security hardening recommendations

    # Performance analyzer
    - name: "performance-analyzer"
      role: "member"
      botRef:
        name: performance-bot
        namespace: default
      prompt: |
        Analyze code from performance perspective:
        - Identify performance bottlenecks
        - Check algorithm complexity
        - Analyze database query efficiency
        - Provide optimization suggestions

    # Quality analyzer
    - name: "quality-analyzer"
      role: "member"
      botRef:
        name: quality-bot
        namespace: default
      prompt: |
        Analyze code from quality perspective:
        - Check code standards
        - Assess maintainability
        - Check test coverage
        - Identify code smells

status:
  state: "Available"
```

### Example 4: Design Discussion Team (Collaborate Mode)

**Scenario**: Architecture design discussion and decision-making

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: architecture-design-team
  namespace: default
spec:
  # Collaborate mode: Free discussion and collaboration
  collaborationModel: "collaborate"

  members:
    # Architect
    - name: "architect"
      role: "member"
      botRef:
        name: architect-bot
        namespace: default
      prompt: |
        You are a system architect, participating in discussions from architecture perspective:
        - Proposing architecture design solutions
        - Evaluating technology choices
        - Considering system scalability
        - Focusing on long-term evolution

    # Backend expert
    - name: "backend-lead"
      role: "member"
      botRef:
        name: backend-lead-bot
        namespace: default
      prompt: |
        You are the backend technical lead, participating from backend perspective:
        - Evaluating backend implementation feasibility
        - Proposing API design suggestions
        - Considering data storage solutions
        - Focusing on performance and security

    # Frontend expert
    - name: "frontend-lead"
      role: "member"
      botRef:
        name: frontend-lead-bot
        namespace: default
      prompt: |
        You are the frontend technical lead, participating from frontend perspective:
        - Evaluating frontend implementation feasibility
        - Proposing user experience suggestions
        - Considering frontend architecture solutions
        - Focusing on performance and accessibility

    # DevOps expert
    - name: "devops-lead"
      role: "member"
      botRef:
        name: devops-bot
        namespace: default
      prompt: |
        You are the DevOps lead, participating from operations perspective:
        - Evaluating deployment and operations difficulty
        - Proposing automation solutions
        - Considering monitoring and alerting
        - Focusing on reliability and cost

status:
  state: "Available"
```

---

## ✨ Best Practices

### 1. Team Size

#### ✅ Recommended

**Small team (2-3 members)**:
- Quick start, simple coordination
- Suitable for simple tasks
- Lower cost

**Medium team (4-6 members)**:
- Clear division of labor
- Suitable for complex tasks
- Balance efficiency and cost

**Large team (7+ members)**:
- Highly specialized
- Suitable for very large projects
- Requires careful coordination

#### ❌ Avoid

- Team too large (>10 members) - High coordination cost
- Team too small (only 1 member) - Loses collaboration advantage

### 2. Role Assignment

#### ✅ Recommended

```yaml
# Pipeline mode: No Leader needed
members:
  - name: "dev"
    role: "member"  # All members are members
  - name: "test"
    role: "member"

# Route/Coordinate mode: Leader needed
members:
  - name: "coordinator"
    role: "leader"  # One Leader
  - name: "worker1"
    role: "member"
  - name: "worker2"
    role: "member"
```

#### ❌ Avoid

```yaml
# Wrong: Pipeline mode doesn't need Leader
collaborationModel: "pipeline"
members:
  - role: "leader"  # Unnecessary

# Wrong: Route mode missing Leader
collaborationModel: "route"
members:
  - role: "member"  # Who will route?
  - role: "member"
```

### 3. Member Prompt Design

#### ✅ Recommended

**Clear responsibility definition**:
```yaml
prompt: |
  You are the team's frontend developer, responsible for:
  - React component development
  - UI/UX implementation
  - Frontend performance optimization

  Working principles:
  - Follow team code standards
  - Write type-safe code
  - Collaborate with backend developers
```

**Include collaboration guidance**:
```yaml
prompt: |
  You are responsible for code review.

  When reviewing:
  - Communicate friendly with developers
  - Provide constructive feedback
  - Acknowledge good design

  After review completion:
  - Pass results to test engineer
```

#### ❌ Avoid

**Too simple**:
```yaml
prompt: "You are a developer"  # Too simple, lacks guidance
```

**Lacks collaboration context**:
```yaml
prompt: |
  You are responsible for frontend development.
  # Missing: How to collaborate with other members?
```

### 4. Collaboration Mode Selection

#### Decision Tree

```
Does task require sequential execution?
├─ Yes → Pipeline
└─ No
    └─ Does task need classification?
        ├─ Yes → Route
        └─ No
            └─ Can task be parallelized?
                ├─ Yes → Coordinate
                └─ No → Collaborate
```

### 5. Cost Optimization

#### Strategy 1: Mix different models

```yaml
members:
  # Core members use powerful models
  - name: "lead-developer"
    botRef:
      name: developer-bot-sonnet  # Sonnet

  # Support members use economical models
  - name: "doc-writer"
    botRef:
      name: doc-bot-haiku  # Haiku
```

#### Strategy 2: Adjust team size as needed

```yaml
# Simple task - Small team
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: simple-task-team
spec:
  members:  # Only 2 members
    - name: "developer"
    - name: "reviewer"

# Complex task - Large team
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: complex-task-team
spec:
  members:  # 5 members
    - name: "architect"
    - name: "frontend-dev"
    - name: "backend-dev"
    - name: "tester"
    - name: "reviewer"
```

---

## ⚠️ Common Issues

### Q1: How to use Team after creation?

**Answer**: Use Team through Task:

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: implement-feature
spec:
  teamRef:
    name: fullstack-dev-team  # Reference Team
    namespace: default
  prompt: "Implement user login feature"
```

### Q2: Can running Team be modified?

**Answer**: Not recommended. If modification needed:

1. Cancel or complete current task
2. Update Team configuration
3. Create new task

### Q3: Can one Bot belong to multiple Teams?

**Answer**: Yes! One Bot can be referenced by multiple Teams:

```yaml
# Team 1
---
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: team-1
spec:
  members:
    - botRef:
        name: shared-bot  # Shared Bot
---
# Team 2
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: team-2
spec:
  members:
    - botRef:
        name: shared-bot  # Same Bot
```

### Q4: How to debug Team collaboration issues?

**Answer**:

1. **Check Task logs**: Understand each Bot's output
2. **Simplify team**: Reduce members, isolate issues
3. **Check prompts**: Ensure member prompts are clear
4. **Verify Bots**: Test each Bot individually

### Q5: Which collaboration mode is best?

**Answer**: No "best" mode, depends on task:

| Task Type | Recommended Mode | Reason |
|-----------|------------------|--------|
| Development process | Pipeline | Sequential execution efficient |
| Problem classification | Route | Highly targeted |
| Multi-angle analysis | Coordinate | Parallel fast |
| Brainstorming | Collaborate | Full discussion |

### Q6: How is Team cost calculated?

**Answer**:

```
Team cost = Σ(Cost of each Bot)

Optimization suggestions:
- Use necessary number of members
- Mix different model levels
- Choose efficient collaboration mode
```

### Q7: How to handle Team execution failure?

**Answer**:

1. **Check Bot status**: Ensure all Bots available
2. **Check references**: Verify all botRef correct
3. **Simplify tasks**: Break complex tasks down
4. **Check logs**: Analyze failure reasons

### Q8: What's the difference between Leader and Member?

**Answer**:

| Role | Responsibilities | Applicable Scenarios |
|------|------------------|---------------------|
| Leader | Coordinate, route, aggregate | Route, Coordinate modes |
| Member | Execute specific tasks | All modes |

**Note**: Pipeline mode typically doesn't need Leader.

---

## 🔗 Related Resources

### Prerequisites
- [Creating Ghosts](./creating-ghosts.md) - Define team members' "souls"
- [Creating Bots](./creating-bots.md) - Assemble complete team members

### Next Steps
- [Managing Tasks](./managing-tasks.md) - Assign tasks to Teams

### Reference Documentation
- [Core Concepts - Collaboration](../../concepts/core-concepts.md#-collaboration) - Deep understanding of collaboration modes
- [YAML Specification - Team](../../reference/yaml-specification.md#-team) - Complete configuration format
- [Best Practices](../../best-practices/team-design.md) - Team design best practices

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions

---

<p align="center">Build your first AI team and experience the power of collaboration! 🚀</p>
