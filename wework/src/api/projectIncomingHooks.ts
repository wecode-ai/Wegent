import type { HttpClient } from './http'

export type ProjectEventSourceType = 'github' | 'gitlab' | 'wework' | 'generic'
export type ProjectEventCollectionMode = 'webhook' | 'poll' | 'internal' | 'hybrid'
export type ProjectAutomationExecutionTarget =
  | 'existing_issue'
  | 'continue_binding'
  | 'create_issue'

export interface ProjectObservedResource {
  resourceType?: string
  instanceUrl?: string | null
  externalId?: string | null
  path?: string | null
  url?: string | null
  displayName?: string | null
}

export interface ProjectEventSourceCatalogItem {
  sourceType: ProjectEventSourceType
  collectionModes: ProjectEventCollectionMode[]
  resourceTypes: string[]
  eventTypes: string[]
  executionTargets: ProjectAutomationExecutionTarget[]
  nameKey: string
  descriptionKey: string
}

export interface ProjectIncomingHook {
  id: string
  projectId: string
  name: string
  status: 'active' | 'disabled'
  sourceType: ProjectEventSourceType
  collectionMode: ProjectEventCollectionMode
  resource: ProjectObservedResource
  webhookUrl: string | null
  webhookSecret: string | null
  pollIntervalSeconds: number | null
  credentialRef: string | null
  health: {
    status?: 'pending' | 'healthy' | 'error'
    checkedAt?: string
    lastError?: string
  }
  lastEventAt: string | null
  nextPollAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProjectIncomingEvent {
  id: string
  subscriptionId: string
  sourceType: string
  collectionMode: string
  status: 'received' | 'processing' | 'processed' | 'unresolved' | 'ignored' | 'failed'
  normalizedEvents: Array<{
    eventType?: string
    resource?: ProjectObservedResource
    subject?: Record<string, unknown>
  }>
  matchedRuns: string[]
  reason: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
}

export interface ProjectIncomingHookInput {
  name: string
  sourceType: ProjectEventSourceType
  collectionMode: ProjectEventCollectionMode
  resource: ProjectObservedResource
  pollIntervalSeconds?: number | null
  credentialRef?: string | null
}

export function createProjectIncomingHookApi(client: HttpClient) {
  return {
    catalog() {
      return client.get<ProjectEventSourceCatalogItem[]>('/v1/cloud-projects/event-sources/catalog')
    },
    list(projectId: string) {
      return client.get<ProjectIncomingHook[]>(`/v1/cloud-projects/${projectId}/incoming-hooks`)
    },
    create(projectId: string, input: ProjectIncomingHookInput) {
      return client.post<ProjectIncomingHook>(
        `/v1/cloud-projects/${projectId}/incoming-hooks`,
        input
      )
    },
    update(
      projectId: string,
      hookId: string,
      input: Partial<ProjectIncomingHookInput> & {
        status?: ProjectIncomingHook['status']
        version: number
      }
    ) {
      return client.patch<ProjectIncomingHook>(
        `/v1/cloud-projects/${projectId}/incoming-hooks/${hookId}`,
        input
      )
    },
    rotate(projectId: string, hookId: string) {
      return client.post<ProjectIncomingHook>(
        `/v1/cloud-projects/${projectId}/incoming-hooks/${hookId}/rotate`
      )
    },
    listEvents(projectId: string, hookId: string, limit = 20) {
      const query = new URLSearchParams({ limit: String(limit) })
      return client.get<ProjectIncomingEvent[]>(
        `/v1/cloud-projects/${projectId}/incoming-hooks/${hookId}/events?${query.toString()}`
      )
    },
  }
}
