import { APIRequestContext } from '@playwright/test'
import { ApiClient, createApiClient } from './api-client'

/**
 * Test resource types that need cleanup
 */
export type CleanupResourceType = 'bot' | 'team' | 'model' | 'group' | 'task' | 'user'

/**
 * Resource to clean up
 */
export interface CleanupResource {
  type: CleanupResourceType
  name: string
  namespace?: string
  id?: string | number
}

/**
 * Cleanup manager for test resources
 * Tracks and cleans up resources created during tests
 */
export class CleanupManager {
  private resources: CleanupResource[] = []
  private apiClient: ApiClient | null = null

  constructor(private request?: APIRequestContext) {}

  /**
   * Initialize with API client
   */
  async initialize(username: string = 'admin', password: string = 'Wegent2025!'): Promise<void> {
    if (!this.request) {
      throw new Error('APIRequestContext is required for cleanup')
    }
    this.apiClient = createApiClient(this.request)
    await this.apiClient.login(username, password)
  }

  /**
   * Set API client directly
   */
  setApiClient(client: ApiClient): void {
    this.apiClient = client
  }

  /**
   * Register a resource for cleanup
   */
  register(resource: CleanupResource): void {
    this.resources.push(resource)
  }

  /**
   * Register a bot for cleanup
   */
  registerBot(name: string, namespace: string = 'default'): void {
    this.register({ type: 'bot', name, namespace })
  }

  /**
   * Register a team for cleanup
   */
  registerTeam(name: string, namespace: string = 'default'): void {
    this.register({ type: 'team', name, namespace })
  }

  /**
   * Register a model for cleanup
   */
  registerModel(name: string): void {
    this.register({ type: 'model', name })
  }

  /**
   * Register a group for cleanup
   */
  registerGroup(name: string): void {
    this.register({ type: 'group', name })
  }

  /**
   * Register a task for cleanup
   */
  registerTask(id: string): void {
    this.register({ type: 'task', name: '', id })
  }

  /**
   * Register a user for cleanup
   */
  registerUser(id: number): void {
    this.register({ type: 'user', name: '', id })
  }

  /**
   * Clean up a single resource
   */
  private async cleanupResource(resource: CleanupResource): Promise<void> {
    if (!this.apiClient) {
      console.warn('API client not initialized, skipping cleanup')
      return
    }

    try {
      switch (resource.type) {
        case 'bot':
          await this.apiClient.deleteBot(resource.name, resource.namespace)
          break
        case 'team':
          await this.apiClient.deleteTeam(resource.name, resource.namespace)
          break
        case 'model':
          await this.apiClient.deleteModel(resource.name)
          break
        case 'group':
          await this.apiClient.deleteGroup(resource.name)
          break
        case 'task':
          if (resource.id) {
            await this.apiClient.deleteTask(String(resource.id))
          }
          break
        case 'user':
          if (resource.id) {
            await this.apiClient.adminDeleteUser(Number(resource.id))
          }
          break
      }
      console.log(`Cleaned up ${resource.type}: ${resource.name || resource.id}`)
    } catch (error) {
      // Ignore cleanup errors (resource might already be deleted)
      console.warn(`Failed to cleanup ${resource.type} ${resource.name || resource.id}:`, error)
    }
  }

  /**
   * Clean up all registered resources
   * Cleanup is done in reverse order (LIFO)
   */
  async cleanupAll(): Promise<void> {
    const resourcesToClean = [...this.resources].reverse()
    this.resources = []

    for (const resource of resourcesToClean) {
      await this.cleanupResource(resource)
    }
  }

  /**
   * Clean up resources of a specific type
   */
  async cleanupByType(type: CleanupResourceType): Promise<void> {
    const matching = this.resources.filter(r => r.type === type)
    this.resources = this.resources.filter(r => r.type !== type)

    for (const resource of matching.reverse()) {
      await this.cleanupResource(resource)
    }
  }

  /**
   * Get number of registered resources
   */
  get count(): number {
    return this.resources.length
  }

  /**
   * Check if any resources are registered
   */
  get hasResources(): boolean {
    return this.resources.length > 0
  }

  /**
   * Get list of registered resources
   */
  getResources(): CleanupResource[] {
    return [...this.resources]
  }

  /**
   * Clear all registered resources without cleaning up
   */
  clear(): void {
    this.resources = []
  }
}

/**
 * Create a cleanup manager instance
 */
export function createCleanupManager(request?: APIRequestContext): CleanupManager {
  return new CleanupManager(request)
}

/**
 * Clean up E2E test data pattern
 * Removes all resources matching the e2e test prefix pattern
 */
export async function cleanupE2ETestData(
  apiClient: ApiClient,
  prefix: string = 'e2e-'
): Promise<void> {
  console.log(`Cleaning up test data with prefix: ${prefix}`)

  // Clean up bots
  try {
    const botsResponse = await apiClient.getBots('all')
    if (botsResponse.data && Array.isArray(botsResponse.data)) {
      for (const bot of botsResponse.data) {
        if (bot.metadata?.name?.startsWith(prefix)) {
          await apiClient
            .deleteBot(bot.metadata.name, bot.metadata.namespace || 'default')
            .catch(() => {})
        }
      }
    }
  } catch {
    console.warn('Failed to cleanup bots')
  }

  // Clean up teams
  try {
    const teamsResponse = await apiClient.getTeams('all')
    if (teamsResponse.data && Array.isArray(teamsResponse.data)) {
      for (const team of teamsResponse.data) {
        if (team.metadata?.name?.startsWith(prefix)) {
          await apiClient
            .deleteTeam(team.metadata.name, team.metadata.namespace || 'default')
            .catch(() => {})
        }
      }
    }
  } catch {
    console.warn('Failed to cleanup teams')
  }

  // Clean up groups
  try {
    const groupsResponse = await apiClient.getGroups()
    if (groupsResponse.data && Array.isArray(groupsResponse.data)) {
      for (const group of groupsResponse.data) {
        if (group.name?.startsWith(prefix)) {
          await apiClient.deleteGroup(group.name).catch(() => {})
        }
      }
    }
  } catch {
    console.warn('Failed to cleanup groups')
  }

  console.log('Test data cleanup completed')
}
