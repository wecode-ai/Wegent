import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { StandInGeneratedEventMap } from '@/telemetry/generated/standInEvents'
import type {
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
  WorkspaceRuntimeTaskAddress,
  RunnerModel,
} from '@wegent/collaboration'
import type { RuntimeTaskSummary } from '@/types/api'

export interface ConnectionProviderDescriptor {
  id: string
  displayName: string
  resourceKinds: string[]
  resourceLabels?: Record<string, string>
  locales?: Record<string, { displayName?: string; resourceLabels?: Record<string, string> }>
  authTarget?: { pluginKey: string; connectorSlug: string }
  availability: { status: string; code?: string }
  dependencies: Array<{ alias: string; status: string }>
}

export interface StandInInboxMessage {
  id: string
  recordId: string
  text: string
  senderId: string
  at: string
  source: StandInSourceConnection
}

export interface StandInInboxWork {
  id: string
  taskId: string
  roleId: string
  title: string
  source: StandInSourceConnection
  status: 'pending' | 'needs_grouping' | 'sending' | 'sent' | 'failed'
  updatedAt: string
  messageCount: number
  latestMessage: StandInInboxMessage | null
  task?: RuntimeTaskSummary | null
  error?: string | null
}

export interface StandInSourceError {
  source: StandInSourceConnection
  error: { code: string; message: string }
}

export interface StandInProcessingStatus {
  awaitingUser?: boolean
  taskId?: string
  pendingCount: number
  running: boolean
  nextCheckAt?: string
  lastCheckAt?: string
  error?: { code: string; message: string } | null
  actions: Array<{
    id: string
    kind: string
    status: string
    createdAt: string
    error?: { code: string; message: string } | null
  }>
}
import {
  publishPersonalStandIn,
  type PersonalStandInAgent,
  type PersonalStandInSettings,
  type StandInSourceConnection,
} from './personalStandIn'

export interface StandInProposal {
  id: string
  summary: string
  roleId?: string | null
  settings: PersonalStandInSettings
  status: 'pending' | 'accepted' | 'rejected'
}

export type StandInMemoryScope =
  | { kind: 'personal' }
  | { kind: 'role'; roleId: string }
  | { kind: 'project'; id: string; store: 'local' | 'cloud' }
  | { kind: 'dingtalk'; id: string; profile: string; conversationKind: 'group' | 'direct' }
  | { kind: 'connection'; providerId: string; id: string; profile: string; resourceKind: string }

export interface StandInMemory {
  id: string
  content: string
  scope: StandInMemoryScope
  version: number
  createdAt: string
  updatedAt: string
  sourceTaskId?: string | null
}

type Request = <T>(method: string, payload: Record<string, unknown>, deviceId: string) => Promise<T>
type ProjectStore = 'local' | 'cloud'
export type StandInProjectSettings = WorkspaceStandInSettings & {
  projectId: string
  projectStore: ProjectStore
  userId: number
}
export type StandInTelemetryFact = {
  [Name in keyof StandInGeneratedEventMap]: {
    name: Name
    properties: StandInGeneratedEventMap[Name]
    id: string
    occurredAt: number
  }
}[keyof StandInGeneratedEventMap]

export interface StandInExecutorApi {
  processingStatus(userId: number, deviceId: string): Promise<StandInProcessingStatus>
  checkProcessing(userId: number, deviceId: string): Promise<StandInProcessingStatus>
  configureTelemetry(
    userId: number,
    deviceId: string,
    enabled: boolean,
    enabledSince?: number
  ): Promise<void>
  telemetryFacts(userId: number, deviceId: string): Promise<{ items: StandInTelemetryFact[] }>
  acknowledgeTelemetry(userId: number, deviceId: string, ids: string[]): Promise<void>
  connectionProviders(deviceId: string): Promise<{ items: ConnectionProviderDescriptor[] }>
  installConnectionDependencies(
    deviceId: string,
    providerId: string,
    aliases: string[]
  ): Promise<unknown>
  organizeWork(
    userId: number,
    deviceId: string,
    workId: string,
    messageIds: string[],
    targetWorkId?: string,
    telemetryAction?: 'split' | 'merge' | 'move' | 'undo'
  ): Promise<StandInInboxWork>
  memories(userId: number, deviceId: string): Promise<StandInMemory[]>
  saveMemory(
    userId: number,
    deviceId: string,
    memory: Pick<StandInMemory, 'content' | 'scope'> & Partial<StandInMemory>
  ): Promise<StandInMemory>
  deleteMemory(userId: number, deviceId: string, id: string, version: number): Promise<void>
  inbox(
    userId: number,
    deviceId: string
  ): Promise<{ items: StandInInboxWork[]; sourceErrors: StandInSourceError[] }>
  workMessages(
    userId: number,
    deviceId: string,
    workId: string
  ): Promise<{ messages: StandInInboxMessage[] }>
  runWork(userId: number, deviceId: string, workId: string): Promise<WorkspaceRuntimeTaskAddress>
  adjustMessage(
    userId: number,
    deviceId: string,
    workId: string,
    messageId: string,
    targetWorkId?: string
  ): Promise<StandInInboxWork>
  retrySource(userId: number, deviceId: string, source: StandInSourceConnection): Promise<void>
  searchConnectionResources(
    deviceId: string,
    providerId: string,
    kind: string,
    query: string,
    cursor?: string
  ): Promise<{
    items: Pick<StandInSourceConnection, 'id' | 'name' | 'kind' | 'profile' | 'providerId'>[]
    hasMore?: boolean
    nextCursor?: string
  }>
  conversation(
    userId: number,
    deviceId: string,
    message: string,
    roleId?: string,
    options?: Record<string, unknown>
  ): Promise<WorkspaceRuntimeTaskAddress>
  proposal(userId: number, deviceId: string, roleId?: string): Promise<StandInProposal | null>
  resolveProposal(
    userId: number,
    deviceId: string,
    proposalId: string,
    accept: boolean
  ): Promise<PersonalStandInSettings>
  notifyAssignment(
    projectId: string,
    issueId: string,
    assignmentId: string,
    userId: number,
    deviceId: string
  ): Promise<void>
  personalAgents(userId: number, deviceId: string): Promise<PersonalStandInAgent[]>
  personalGet(userId: number, deviceId: string): Promise<PersonalStandInSettings>
  personalSave(
    userId: number,
    settings: PersonalStandInSettings,
    deviceId: string
  ): Promise<PersonalStandInSettings>
  readTask(
    deviceId: string,
    taskId: string
  ): Promise<{ success: boolean; task?: RuntimeTaskSummary; code?: string; error?: string }>
  catalog(deviceId: string): Promise<{ models: RunnerModel[] }>
  run(
    projectId: string,
    issueId: string,
    userId: number,
    projectStore: ProjectStore,
    deviceId: string,
    standInId?: string
  ): Promise<WorkspaceRuntimeTaskAddress>
  list(
    userId: number,
    deviceId: string,
    includeDisabled?: boolean
  ): Promise<StandInProjectSettings[]>
  get(
    projectId: string,
    userId: number,
    projectStore: ProjectStore,
    deviceId: string,
    standInId?: string
  ): Promise<WorkspaceStandInSettings>
  save(
    projectId: string,
    userId: number,
    projectStore: ProjectStore,
    settings: WorkspaceStandInSettings,
    deviceId: string
  ): Promise<WorkspaceStandInSettings>
}

export function createStandInExecutorApi(transport: Request): StandInExecutorApi {
  const request: Request = async (method, payload, deviceId) => {
    try {
      return await transport(method, payload, deviceId)
    } catch (error) {
      console.warn('[Stand-in] Executor request failed', {
        method,
        deviceId,
        projectId: payload.projectId,
        issueId: payload.issueId ?? payload.itemId,
        assignmentId: payload.assignmentId,
        userId: payload.userId ?? payload.recipientUserId,
        roleId: payload.standInId ?? payload.roleId,
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
      })
      const message = getStandInErrorMessage(error)
      throw Object.assign(
        new Error(message, { cause: error }),
        error && typeof error === 'object' ? error : {},
        { message, cause: error }
      )
    }
  }
  return {
    processingStatus: (userId, deviceId) =>
      request('runtime.stand_in.processing.status', { userId }, deviceId),
    checkProcessing: (userId, deviceId) =>
      request('runtime.stand_in.processing.check', { userId }, deviceId),
    configureTelemetry: async (userId, deviceId, enabled, enabledSince) => {
      await request(
        'runtime.stand_in.telemetry.configure',
        { userId, enabled, ...(enabledSince == null ? {} : { enabledSince }) },
        deviceId
      )
    },
    telemetryFacts: (userId, deviceId) =>
      request('runtime.stand_in.telemetry.list', { userId }, deviceId),
    acknowledgeTelemetry: async (userId, deviceId, ids) => {
      await request('runtime.stand_in.telemetry.ack', { userId, ids }, deviceId)
    },
    connectionProviders: deviceId => request('runtime.connections.catalog', {}, deviceId),
    installConnectionDependencies: (deviceId, providerId, aliases) =>
      request('runtime.connections.dependencies.install', { providerId, aliases }, deviceId),
    memories: async (userId, deviceId) =>
      (
        await request<{ items: StandInMemory[] }>(
          'runtime.stand_in.memory.list',
          { userId },
          deviceId
        )
      ).items,
    saveMemory: (userId, deviceId, memory) =>
      request('runtime.stand_in.memory.save', { userId, memory }, deviceId),
    deleteMemory: async (userId, deviceId, id, version) => {
      await request('runtime.stand_in.memory.delete', { userId, id, version }, deviceId)
    },
    inbox: (userId, deviceId) => request('runtime.stand_in.work.list', { userId }, deviceId),
    workMessages: (userId, deviceId, workId) =>
      request('runtime.stand_in.work.messages', { userId, workId }, deviceId),
    runWork: (userId, deviceId, workId) =>
      request('runtime.stand_in.work.run', { userId, workId }, deviceId),
    organizeWork: (userId, deviceId, workId, messageIds, targetWorkId, telemetryAction) =>
      request(
        'runtime.stand_in.work.organize',
        {
          userId,
          workId,
          messageIds,
          targetWorkId,
          ...(telemetryAction ? { telemetryAction } : {}),
        },
        deviceId
      ),
    adjustMessage: (userId, deviceId, workId, messageId, targetWorkId) =>
      request(
        'runtime.stand_in.work.adjust',
        { userId, workId, messageId, targetWorkId },
        deviceId
      ),
    retrySource: (userId, deviceId, source) =>
      request('runtime.stand_in.source.retry', { userId, source }, deviceId),
    searchConnectionResources: (deviceId, providerId, kind, query, cursor) =>
      request('runtime.connections.resources', { providerId, kind, query, cursor }, deviceId),
    conversation: (userId, deviceId, message, roleId, options) =>
      request('runtime.stand_in.conversation', { userId, message, roleId, options }, deviceId),
    proposal: (userId, deviceId, roleId) =>
      request('runtime.stand_in.proposal.get', { userId, roleId }, deviceId),
    resolveProposal: async (userId, deviceId, proposalId, accept) => {
      const saved = await request<PersonalStandInSettings>(
        'runtime.stand_in.proposal.resolve',
        { userId, proposalId, accept },
        deviceId
      )
      publishPersonalStandIn(saved)
      return saved
    },
    notifyAssignment: async (projectId, itemId, assignmentId, recipientUserId, deviceId) => {
      await request(
        'runtime.stand_in.assignment',
        { projectId, itemId, assignmentId, recipientUserId },
        deviceId
      )
    },
    personalAgents: async (userId, deviceId) =>
      (
        await request<{ items: PersonalStandInAgent[] }>(
          'runtime.stand_in.personal.agents',
          { userId },
          deviceId
        )
      ).items,
    personalGet: (userId, deviceId) =>
      request('runtime.stand_in.personal.get', { userId }, deviceId),
    personalSave: async (userId, settings, deviceId) => {
      const saved = await request<PersonalStandInSettings>(
        'runtime.stand_in.personal.save',
        { userId, settings },
        deviceId
      )
      publishPersonalStandIn(saved)
      return saved
    },
    readTask: (deviceId, taskId) => request('runtime.tasks.get', { taskId }, deviceId),
    catalog: deviceId => request('runtime.runner.catalog', {}, deviceId),
    run: (projectId, issueId, userId, projectStore, deviceId, standInId) =>
      request(
        'runtime.stand_in.run',
        { projectId, issueId, userId, projectStore, ...(standInId ? { standInId } : {}) },
        deviceId
      ),
    list: async (userId, deviceId, includeDisabled) =>
      (
        await request<{ items: StandInProjectSettings[] }>(
          'runtime.stand_in.list',
          { userId, ...(includeDisabled ? { includeDisabled: true } : {}) },
          deviceId
        )
      ).items,
    get: (projectId, userId, projectStore, deviceId, standInId = 'default') =>
      request('runtime.stand_in.get', { projectId, userId, projectStore, standInId }, deviceId),
    save: (projectId, userId, projectStore, settings, deviceId) =>
      request('runtime.stand_in.save', { projectId, userId, projectStore, settings }, deviceId),
  }
}

type SettingsListener = (settings: StandInProjectSettings) => void
const listeners = new Set<SettingsListener>()
export function subscribeStandInSettings(listener: SettingsListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Each Executor owns its settings; the client only reads and edits them. */
export function bindProjectStandInApi(
  api: StandInExecutorApi,
  userId: number,
  projectStore: ProjectStore,
  currentIdentity: () => Promise<{ deviceId: string } | null>
): NonNullable<SharedWorkspaceApi['standIn']> {
  const resolveDevice = async (deviceId?: string) => {
    const target = deviceId || (await currentIdentity())?.deviceId
    if (!target) throw new Error(getStandInErrorMessage({ code: 'stand_in_unavailable' }))
    return target
  }
  return {
    async run(projectId, issueId, deviceId, standInId) {
      const target = await resolveDevice(deviceId)
      return api.run(projectId, issueId, userId, projectStore, target, standInId)
    },
    async get(projectId, deviceId, standInId = 'default') {
      const target = await resolveDevice(deviceId)
      return api.get(projectId, userId, projectStore, target, standInId)
    },
    async save(projectId, settings, deviceId) {
      const target = await resolveDevice(deviceId)
      const saved = await api.save(projectId, userId, projectStore, settings, target)
      for (const listener of listeners) listener({ ...saved, projectId, projectStore, userId })
      return saved
    },
  }
}
