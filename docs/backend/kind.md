<!--
SPDX-FileCopyrightText: 2025 Weibo, Inc.

SPDX-License-Identifier: Apache-2.0
-->

## Core Concepts and Kind Definitions

### 1. Ghost (CRD: Ghost)

Ghost represents the "soul" of an agent, defining the agent's personality (prompt) and capabilities (MCP).

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
  namespace: default
spec:
  # System prompt that defines the agent's personality, corresponds to system_prompt in bots table
  systemPrompt: "You are a professional software developer, skilled in using TypeScript and React to develop frontend applications."
  # MCP server configuration that defines the agent's capabilities, corresponds to mcp_servers in bots table
  # Users can input any object
  mcpServers:
    github:
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ghp_xxxxx
      args:
        - run
        - -i
        - --rm
        - -e
        - GITHUB_PERSONAL_ACCESS_TOKEN
        - -e
        - GITHUB_TOOLSETS
        - -e
        - GITHUB_READ_ONLY
        - ghcr.io/github/github-mcp-server
      command: docker
status:
  state: "Available" # Available, Unavailable
```

### 2. Model (CRD: Model)

Model represents the agent's configuration, including environment variables and other configuration information.

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-model
  namespace: default
spec:
  # User-defined configuration
  modelConfig:
    env:
      ANTHROPIC_MODEL: "claude-4.1-opus"
      ANTHROPIC_API_KEY: "xxxxxx"
      ANTHROPIC_BASE_URL: "sk-xxxxxx"
      ANTHROPIC_SMALL_FAST_MODEL: "claude-3.5-haiku"
status:
  state: "Available" # Available, Unavailable
```

### 3. Shell (CRD: Shell)

Shell is the container where the agent runs, specifying the runtime environment.

```yaml
apiVersion: agent.wecode.io/v1
kind: Shell
metadata:
  name: claude-shell
  namespace: default
spec:
  runtime: "ClaudeCode"
  supportModel:
    - "openai" 
status:
  state: "Available" # Available, Unavailable
```

### 4. Bot (CRD: Bot)

Bot combines Ghost, Shell and Model to create a complete agent instance, corresponding to bots in the system.

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: developer-bot
  namespace: default
spec:
  # Ghost reference
  ghostRef:
    name: developer-ghost
    namespace: default
  # Shell reference
  shellRef:
    name: claude-shell
    namespace: default
  # Model reference
  modelRef:
    name: claude-model
    namespace: default
status:
  state: "Available" # Available, Unavailable
```

### 5. Team (CRD: Team)

Team defines a collection of collaborative bots, corresponding to teams in the system.

```yaml
apiVersion: agent.wecode.io/v1
kind: Team
metadata:
  name: dev-team
  namespace: default
spec:
  # Team members
  members:
    - name: "developer"
      # Reference to Bot
      botRef:
        name: developer-bot
        namespace: default
      # Member-specific prompt, corresponds to bot_prompt in team.bots
      prompt: "You are the developer in the team, responsible for implementing features..."
      role: "leader"
    - name: "reviewer"
      botRef:
        name: reviewer-bot
        namespace: default
      prompt: "You are the code reviewer in the team, responsible for reviewing code quality..."
  collaborationModel: "pipeline" # pipeline、route、coordinate、collaborate
status:
  state: "Available" # Available, Unavailable
```

### 6. Workspace (CRD: Workspace)

Workspace defines the team's working environment, including code repository, branch information, etc.

```yaml
apiVersion: agent.wecode.io/v1
kind: Workspace
metadata:
  name: project-workspace
  namespace: default
spec:
  # Code repository information, corresponds to git-related fields in task table
  repository:
    gitUrl: "https://github.com/user/repo.git"
    gitRepo: "user/repo"
    gitRepoId: 12345
    branchName: "main"
    gitDomain: "github.com"
status:
  state: "Available" # Available, Unavailable
```

### 7. Task (CRD: Task)

Task defines the task to be executed, associates Team and Workspace, corresponding to tasks in the system.

```yaml
apiVersion: agent.wecode.io/v1
kind: Task
metadata:
  name: implement-feature
  namespace: default
spec:
  title: "Implement new feature"
  prompt: "Task description"
  teamRef:
    name: dev-team
    namespace: default
  workspaceRef:
    name: project-workspace
    namespace: default
status:
  state: "Available" # Available, Unavailable
  status: "PENDING" # 'PENDING','RUNNING','COMPLETED','FAILED','CANCELLED','DELETE'
  progress: 0
  result: null
  errorMessage: null
  createdAt: null
  updatedAt: null
  completedAt: null
```