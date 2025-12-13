/**
 * Test data builders using builder pattern
 * Provides factory functions for creating test data
 */

// Type definitions
export interface BotData {
  name: string
  kind: string
  apiVersion: string
  metadata: { name: string; namespace: string }
  spec: {
    description?: string
    ghostRef?: { name: string; namespace?: string }
    shellRef?: { name: string; namespace?: string }
    modelRef?: { name: string; namespace?: string }
    agent_config?: {
      bind_model?: string
      bind_model_type?: 'public' | 'user' | 'group'
    }
  }
}

export interface ModelData {
  name: string
  provider: string
  model_id: string
  api_key: string
  base_url: string
  description?: string
  is_custom_config?: boolean
}

export interface TeamData {
  name: string
  kind: string
  apiVersion: string
  metadata: { name: string; namespace: string }
  spec: {
    description?: string
    collaborationModel?: 'coordinate' | 'collaborate' | 'route'
    members?: Array<{
      botRef: { name: string; namespace?: string }
      prompt?: string
      role?: string
    }>
  }
}

export interface GroupData {
  name: string
  display_name?: string
  description?: string
  visibility?: 'private' | 'internal' | 'public'
}

export interface UserData {
  user_name: string
  email?: string
  password: string
  role: 'admin' | 'user'
  auth_source?: 'password' | 'oidc' | 'unknown'
}

export interface TaskData {
  title: string
  prompt: string
  teamRef: { name: string; namespace?: string }
  workspaceRef?: { name: string; namespace?: string }
}

export interface ShellData {
  name: string
  kind: string
  apiVersion: string
  metadata: { name: string; namespace: string }
  spec: {
    shellType: 'ClaudeCode' | 'Agno' | 'Dify' | 'Chat'
    description?: string
    baseImage?: string
    supportModel?: string[]
    baseShellRef?: { name: string; namespace?: string }
  }
}

export interface WorkspaceData {
  name: string
  kind: string
  apiVersion: string
  metadata: { name: string; namespace: string }
  spec: {
    repository: {
      gitUrl: string
      gitRepo: string
      branchName: string
      gitDomain: string
    }
  }
}

/**
 * Data Builders class with static factory methods
 */
export class DataBuilders {
  /**
   * Generate a unique ID for test data
   */
  static uniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Generate a unique test name with prefix
   */
  static uniqueName(prefix: string): string {
    return `${prefix}-${this.uniqueId()}`
  }

  /**
   * Create a Bot test data object
   */
  static bot(overrides?: Partial<BotData>): BotData {
    const name = `e2e-bot-${this.uniqueId()}`
    return {
      name,
      kind: 'Bot',
      apiVersion: 'agent.wecode.io/v1',
      metadata: {
        name,
        namespace: 'default',
      },
      spec: {
        description: `E2E test bot created at ${new Date().toISOString()}`,
        ghostRef: { name: 'default-ghost' },
        shellRef: { name: 'claude-code' },
        agent_config: {
          bind_model: 'claude-sonnet',
          bind_model_type: 'public',
        },
      },
      ...overrides,
    }
  }

  /**
   * Create a Model test data object
   */
  static model(overrides?: Partial<ModelData>): ModelData {
    return {
      name: `e2e-model-${this.uniqueId()}`,
      provider: 'openai',
      model_id: 'gpt-4',
      api_key: `test-key-${this.uniqueId()}`,
      base_url: 'https://api.openai.com/v1',
      description: `E2E test model created at ${new Date().toISOString()}`,
      ...overrides,
    }
  }

  /**
   * Create a Team test data object
   */
  static team(overrides?: Partial<TeamData>): TeamData {
    const name = `e2e-team-${this.uniqueId()}`
    return {
      name,
      kind: 'Team',
      apiVersion: 'agent.wecode.io/v1',
      metadata: {
        name,
        namespace: 'default',
      },
      spec: {
        description: `E2E test team created at ${new Date().toISOString()}`,
        collaborationModel: 'collaborate',
        members: [],
      },
      ...overrides,
    }
  }

  /**
   * Create a Group test data object
   */
  static group(overrides?: Partial<GroupData>): GroupData {
    return {
      name: `e2e-group-${this.uniqueId()}`,
      display_name: `E2E Test Group ${Date.now()}`,
      description: `E2E test group created at ${new Date().toISOString()}`,
      visibility: 'public',
      ...overrides,
    }
  }

  /**
   * Create a User test data object
   */
  static user(role: 'admin' | 'user' = 'user', overrides?: Partial<UserData>): UserData {
    return {
      user_name: `e2e-user-${this.uniqueId()}`,
      email: `e2e-${this.uniqueId()}@test.example.com`,
      password: 'Test@12345',
      role,
      auth_source: 'password',
      ...overrides,
    }
  }

  /**
   * Create a Task test data object
   */
  static task(overrides?: Partial<TaskData>): TaskData {
    return {
      title: `E2E Test Task ${Date.now()}`,
      prompt: `This is an E2E test task created at ${new Date().toISOString()}`,
      teamRef: { name: 'default-team' },
      ...overrides,
    }
  }

  /**
   * Create a Shell test data object
   */
  static shell(overrides?: Partial<ShellData>): ShellData {
    const name = `e2e-shell-${this.uniqueId()}`
    return {
      name,
      kind: 'Shell',
      apiVersion: 'agent.wecode.io/v1',
      metadata: {
        name,
        namespace: 'default',
      },
      spec: {
        shellType: 'ClaudeCode',
        description: `E2E test shell created at ${new Date().toISOString()}`,
        baseImage: 'python:3.11',
        supportModel: ['claude-sonnet'],
      },
      ...overrides,
    }
  }

  /**
   * Create a Workspace test data object
   */
  static workspace(overrides?: Partial<WorkspaceData>): WorkspaceData {
    const name = `e2e-workspace-${this.uniqueId()}`
    return {
      name,
      kind: 'Workspace',
      apiVersion: 'agent.wecode.io/v1',
      metadata: {
        name,
        namespace: 'default',
      },
      spec: {
        repository: {
          gitUrl: 'https://github.com/example/repo.git',
          gitRepo: 'example/repo',
          branchName: 'main',
          gitDomain: 'github.com',
        },
      },
      ...overrides,
    }
  }

  /**
   * Create hierarchical group name (for nested groups)
   */
  static hierarchicalGroupName(depth: number = 2): string {
    const parts = []
    for (let i = 0; i < depth; i++) {
      parts.push(`level${i}-${Math.random().toString(36).substr(2, 4)}`)
    }
    return parts.join('/')
  }

  /**
   * Create a batch of bots
   */
  static bots(count: number, overrides?: Partial<BotData>): BotData[] {
    return Array.from({ length: count }, () => this.bot(overrides))
  }

  /**
   * Create a batch of teams
   */
  static teams(count: number, overrides?: Partial<TeamData>): TeamData[] {
    return Array.from({ length: count }, () => this.team(overrides))
  }

  /**
   * Create a batch of models
   */
  static models(count: number, overrides?: Partial<ModelData>): ModelData[] {
    return Array.from({ length: count }, () => this.model(overrides))
  }
}
