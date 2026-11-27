import type { StandInShareApi } from './personalStandIn'
import {
  installStandInConnectionDependencies,
  type ConnectionDependencyPluginApi,
} from './standInConnectionDependencies'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { getDeviceTimezone } from '@/lib/timezone'
import type { StandInGeneratedEventMap } from '@/telemetry/generated/standInEvents'
import type {
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
  WorkspaceRuntimeTaskAddress,
  RunnerModel,
} from '@wegent/collaboration'
import type { RuntimeTaskSummary } from '@/types/api'
import type { Automation } from '@/types/automation'
import { createRuntimeTaskCommandsApi, type RuntimeTaskCommandsApi } from './runtimeTaskCommands'
import { LOCAL_USER } from './local/localSession'

export interface StandInOnboardingResult {
  settings?: PersonalStandInSettings | null
  state: { version: number; completed: boolean; weeklyReview?: boolean }
  reviewTemplate: Omit<Automation, 'source'>
}

export interface StandInBindingTarget {
  userId: number
  deviceId: string
  backendUrl?: string
}

export interface StandInInstanceBinding {
  version: number
  // Account-backed workspaces also use unavailable when no lifecycle read has succeeded.
  status: 'unbound' | 'activating' | 'active' | 'stopping' | 'stopped' | 'unavailable'
  target: StandInBindingTarget | null
  stoppingTargets?: string[]
}

export function isStandInBindingOwner(targetUserId: number, userId: number): boolean {
  return targetUserId === LOCAL_USER.id || targetUserId === userId
}

export interface ConnectionProviderDescriptor {
  id: string
  displayName: string
  resourceKinds: string[]
  allResourceLabel?: string
  allResourceKinds?: string[]
  allResourceLabels?: Record<string, string>
  resourceLabels?: Record<string, string>
  locales?: Record<
    string,
    {
      displayName?: string
      resourceLabels?: Record<string, string>
      allResourceLabels?: Record<string, string>
      allResourceLabel?: string
    }
  >
  authTarget?: { pluginKey: string; connectorSlug: string }
  availability: {
    status: string
    code?: string
    profile?: string
    accountId?: string
    accountName?: string
    organizationName?: string
  }
  dependencies: Array<{
    alias: string
    status: string
    source?: { marketplaceId: string; pluginId: string }
    version?: string
  }>
}

export interface ConnectionReadinessIdentity {
  profile: string
  accountId: string
  accountName: string
  organizationId: string
  organizationName: string
}

export interface ConnectionReadinessSource {
  id: string
  kind: 'direct' | 'group'
}

export interface ConnectionReadiness {
  status:
    | 'ready'
    | 'auth_required'
    | 'identity_required'
    | 'permissions_required'
    | 'component_unavailable'
    | 'error'
  code?: string
  identity?: ConnectionReadinessIdentity
  candidates?: ConnectionReadinessIdentity[]
  component?: { source: 'managed' | 'bundled' | 'external'; version: string }
  permissions?: { read: 'verified' | 'unchecked'; reply: 'unverified' }
  authTarget?: ConnectionProviderDescriptor['authTarget']
}

export interface StandInDelegationResult {
  action: 'reply' | 'needs_user' | 'skip'
  status: 'complete' | 'submitting' | 'sent' | 'failed' | 'unknown'
  reason: string
  reasonCode?: 'owner_intervened' | 'model_skipped'
  deliveryReason?: string
  deliveryReasonCode?: string
  attemptId?: string
  recordId?: string
  channelTaskId?: string
  receiptId?: string
  takenOver?: boolean
}

export interface StandInInboxMessage {
  id: string
  recordId: string
  text: string
  senderId: string
  at: string
  source: StandInSourceConnection
  delegationResult?: StandInDelegationResult
}

export interface StandInInboxWork {
  id: string
  taskId: string
  roleId: string
  title: string
  source: StandInSourceConnection
  status: 'pending' | 'needs_grouping' | 'sending' | 'sent' | 'failed'
  updatedAt: string
  refreshVersion?: string
  messageCount: number
  latestMessage: StandInInboxMessage | null
  delegationResult?: StandInDelegationResult
  takenOverAt?: string
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
  error?: { code: string; message: string; taskId?: string; commandId?: string } | null
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
  type PersonalStandInSettings,
  type StandInDelegationRoute,
  type StandInSourceConnection,
  type StandInTaskPermissions,
} from './personalStandIn'

export interface StandInProposal {
  id: string
  summary: string
  training?: {
    before: string
    after: string
    cases: Array<{ id: string; scene: string; actual?: string; expected: string }>
    evaluation: Array<{
      caseId: string
      baseline: string
      candidate: string
      reason: string
      confirmationReason?: string
    }>
  }
  roleId?: string | null
  settings: PersonalStandInSettings
  status: 'pending' | 'accepted' | 'rejected'
}

export interface StandInGhostRevision {
  id: string
  before: string
  after: string
  version: number
}

export interface StandInLearningDimension {
  id: 'intent' | 'verification' | 'judgment' | 'actionability' | 'clarity'
  baselineScore: number | null
  candidateScore: number | null
  sampleCount: number
  insufficientCount: number
  notApplicableCount: number
}

export interface StandInLearningReport {
  iterations: number
  latest: {
    status: 'pending' | 'accepted' | 'rejected' | 'reverted' | 'obsolete' | 'unchanged'
    evaluatedAt: string
    currentScore: number | null
    baselineScore: number | null
    candidateScore: number | null
    sampleCount: number | null
    dimensions?: StandInLearningDimension[] | null
    pendingProposalId?: string | null
  } | null
  revision: StandInGhostRevision | null
}

export type StandInLearningRunStatus =
  | 'started'
  | 'busy'
  | 'disabled'
  | 'insufficient'
  | 'already_evaluated'

export type StandInMemoryScope =
  | { kind: 'personal' }
  | { kind: 'role'; roleId: string }
  | { kind: 'project'; id: string; store: 'local' | 'cloud' }
  | { kind: 'project_coordinator'; id: string; store: 'local' | 'cloud' }
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
  evidenceUnavailable?: boolean
  evidence?: {
    taskId?: string
    messageId?: string
    role?: string | null
    excerpt?: string
    observedAt?: string | number | null
    readAt?: string
    trainingCase?:
      | { kind: 'observation'; roleId: string; source?: { id?: string; name?: string } }
      | {
          kind: 'demonstration' | 'correction' | 'positive'
          roleId: string
          scene: string
          actual?: string
          expected: string
        }
  } | null
}

export type StandInMemoryRule =
  | (Pick<StandInMemory, 'id' | 'content' | 'scope' | 'version' | 'createdAt' | 'updatedAt'> & {
      kind: 'forgetting_rule'
      evidenceUnavailable?: boolean
    })
  | {
      kind: 'legacy_fingerprint'
      id: string
      version: number
      updatedAt: string
    }

export type StandInReworkComparison =
  | { status: 'insufficient' }
  | {
      status: 'inconclusive' | 'lower' | 'higher'
      dimension: 'ghost' | 'memory'
      baselineVersion: string
      currentVersion: string
      baselineRequests: number
      currentRequests: number
      matchedSources: number
      difference: number
      lowerBound: number
      upperBound: number
    }

export interface StandInReworkReport {
  roleId: string
  windowHours: number
  lastBackgroundVerifiedAt?: string | null
  completeRequests: number
  ownerReworkRequests: number
  confirmedReworkRequests?: number
  outsideRateReworkRequests?: number
  pendingRequests: number
  incompleteRequests: number
  unattributedRequests: number
  comparison: StandInReworkComparison
  memoryComparison?: StandInReworkComparison | null
}

type Request = <T>(method: string, payload: Record<string, unknown>, deviceId: string) => Promise<T>
type ProjectStore = 'local' | 'cloud'

export interface ProjectCoordinatorTarget {
  projectId: string
  projectStore: ProjectStore
  groupId: string
}

export interface ProjectCoordinationBinding {
  enabled: boolean
  userId: number
  deviceId: string
  generation: string
  sourceCutoff: string
  updatedBy: number
  updatedAt: string
}

export interface ProjectCoordinationUpdate {
  enabled: boolean
  expectedGeneration: string | null
  takeover?: boolean
}

export interface ProjectCoordinationState {
  binding: ProjectCoordinationBinding | null
  canEnable: boolean
  canStop: boolean
}
export interface ProjectCoordinationProcessing {
  contextId: string
  lastCheckAt: string | null
  nextCheckAt: string | null
  running: boolean
  questions: Record<string, { issueId: string; question: string; batchId: string }>
  error: string | null
}
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

export interface RemoteStandInRoleBranch {
  taskId: string
  createdAt: string
  root: string
  title: string
  roleName?: string
  deviceId: string
  parentTaskId: string
  ancestors: string[]
  prerequisiteTaskIds?: string[] | null
  taskAddress?: { deviceId: string; taskId: string } | null
  attempt: number
  retryAllowed: boolean
  statusSource?: 'local_execution'
  waitingForChildren?: boolean
  status:
    | 'waiting_for_device'
    | 'waiting_for_dependencies'
    | 'blocked_by_dependency'
    | 'waiting_for_user'
    | 'waiting_for_parent'
    | 'dispatched'
    | 'retrying'
    | 'running'
    | 'done'
    | 'failed'
    | 'cancelling'
    | 'cancelling_waiting_for_device'
    | 'cancelled'
  errorCode?: string | null
  cancelGroup?: boolean
}

export interface StandInTaskPermissionSnapshot {
  taskPermissions: StandInTaskPermissions
  snapshotRevision?: string | null
}

export interface StandInExecutorApi {
  sharing: StandInShareApi
  deviceIdentity(deviceId: string): Promise<{ deviceId: string; backendDeviceId: string }>
  gitConnection(deviceId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>
  onboarding(userId: number, deviceId: string, language: string): Promise<StandInOnboardingResult>
  completeOnboarding(
    userId: number,
    deviceId: string,
    weeklyReview: boolean,
    time: string,
    language: string
  ): Promise<StandInOnboardingResult>
  projectProcessing(
    userId: number,
    deviceId: string,
    target: ProjectCoordinatorTarget,
    check?: boolean
  ): Promise<ProjectCoordinationProcessing>
  projectCoordination(
    userId: number,
    deviceId: string,
    target: ProjectCoordinatorTarget,
    update?: ProjectCoordinationUpdate
  ): Promise<ProjectCoordinationState>
  processingStatus(userId: number, deviceId: string): Promise<StandInProcessingStatus>
  binding(
    deviceId: string,
    operation?:
      | 'get'
      | 'bind'
      | 'beginStop'
      | 'completeStop'
      | 'prepareBind'
      | 'prepareReplacement'
      | 'completeActivation'
      | 'markStopping'
      | 'clearStopping',
    version?: number,
    target?: StandInBindingTarget
  ): Promise<StandInInstanceBinding>
  lifecycle(
    userId: number,
    deviceId: string,
    operation: 'start' | 'stop',
    expectedVersion?: number
  ): Promise<PersonalStandInSettings>
  taskCommands: RuntimeTaskCommandsApi
  setTaskPermissions(
    userId: number,
    deviceId: string,
    taskId: string,
    taskPermissions: StandInTaskPermissions
  ): Promise<StandInTaskPermissionSnapshot>
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
  connectionReadiness(
    deviceId: string,
    providerId: string,
    profile?: string,
    sources?: ConnectionReadinessSource[]
  ): Promise<ConnectionReadiness>
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
  reworkReport(userId: number, deviceId: string, roleId: string): Promise<StandInReworkReport>
  memoryRules(userId: number, deviceId: string): Promise<StandInMemoryRule[]>
  deleteMemoryRule(
    userId: number,
    deviceId: string,
    id: string,
    version: number,
    expectedUpdatedAt?: string
  ): Promise<void>
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
  remoteRoleBranches(
    userId: number,
    deviceId: string,
    taskId: string
  ): Promise<{ items: RemoteStandInRoleBranch[] }>
  cancelRoleWork(
    userId: number,
    deviceId: string,
    taskId: string,
    root: string,
    branchTaskId?: string
  ): Promise<void>
  retryRoleWork(
    userId: number,
    deviceId: string,
    taskId: string,
    root: string,
    branchTaskId: string,
    attempt: number
  ): Promise<void>
  workMessages(
    userId: number,
    deviceId: string,
    workId: string
  ): Promise<{ messages: StandInInboxMessage[] }>
  takeOverWork(userId: number, deviceId: string, workId: string): Promise<void>
  verifyWorkDelivery(
    userId: number,
    deviceId: string,
    workId: string,
    recordId: string
  ): Promise<void>
  runWork(
    userId: number,
    deviceId: string,
    workId: string,
    options?: { confirmThisRun?: boolean }
  ): Promise<WorkspaceRuntimeTaskAddress>
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
    cursor?: string,
    scope?: 'all',
    profile?: string
  ): Promise<{
    items: Pick<
      StandInSourceConnection,
      | 'id'
      | 'name'
      | 'kind'
      | 'profile'
      | 'accountId'
      | 'providerId'
      | 'scope'
      | 'collectionKey'
      | 'configurationSummary'
    >[]
    hasMore?: boolean
    nextCursor?: string
    availability?: {
      status: string
      code?: string
      authTarget?: import('./local/localConnectorAuth').LocalConnectorAuthTarget
    }
  }>
  conversation(
    userId: number,
    deviceId: string,
    message: string,
    roleId?: string,
    options?: Record<string, unknown>
  ): Promise<WorkspaceRuntimeTaskAddress>
  projectConversation(
    userId: number,
    deviceId: string,
    projectId: string,
    projectStore: ProjectStore,
    groupId: string,
    message?: string,
    options?: Record<string, unknown>
  ): Promise<{ taskId: string; address: WorkspaceRuntimeTaskAddress | null }>
  proposal(userId: number, deviceId: string, roleId?: string): Promise<StandInProposal | null>
  learningReport(userId: number, deviceId: string, roleId?: string): Promise<StandInLearningReport>
  runLearning(
    userId: number,
    deviceId: string,
    roleId?: string
  ): Promise<{ status: StandInLearningRunStatus }>
  resolveProposal(
    userId: number,
    deviceId: string,
    proposalId: string,
    accept: boolean,
    undoVersion?: number
  ): Promise<PersonalStandInSettings>
  notifyAssignment(
    projectId: string,
    issueId: string,
    assignmentId: string,
    userId: number,
    deviceId: string
  ): Promise<void>
  personalGet(
    userId: number,
    deviceId: string,
    options?: { deviceSettingsOnly?: boolean; roleDirectory?: boolean }
  ): Promise<PersonalStandInSettings>
  personalSave(
    userId: number,
    settings: PersonalStandInSettings,
    deviceId: string,
    transferRoleId?: string,
    definitionChange?: { kind: 'create' | 'update' | 'delete'; roleId: string }
  ): Promise<PersonalStandInSettings>
  saveDelegationRoute(
    userId: number,
    deviceId: string,
    version: number,
    roleId: string,
    route: StandInDelegationRoute | null
  ): Promise<PersonalStandInSettings>
  readTask(
    deviceId: string,
    taskId: string,
    options?: { resolveActiveProvider?: boolean }
  ): Promise<{
    success: boolean
    deviceId?: string
    task?: RuntimeTaskSummary
    code?: string
    error?: string
  }>
  assignmentTasks(
    userId: number,
    deviceId: string,
    assignments: Array<{ projectId: string; itemId: string; humanAssignmentId: string }>
  ): Promise<{ items: RuntimeTaskSummary[] }>
  catalog(deviceId: string): Promise<{ models: RunnerModel[]; errors?: string[] }>
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

export function createStandInExecutorApi(
  transport: Request,
  dependencyPlugins?: ConnectionDependencyPluginApi
): StandInExecutorApi {
  const personalReads = new Map<string, Promise<PersonalStandInSettings>>()
  const request: Request = async (method, payload, deviceId) => {
    const changesProfile = [
      'runtime.stand_in.personal.save',
      'runtime.stand_in.share.copy',
      'runtime.stand_in.personal.lifecycle',
      'runtime.stand_in.proposal.resolve',
      'runtime.stand_in.onboarding.complete',
    ].includes(method)
    const invalidate = () => {
      if (!changesProfile) return
      // A profile may be addressed through more than one verified Runtime route.
      const prefix = JSON.stringify([payload.userId]).slice(0, -1) + ','
      for (const key of personalReads.keys()) if (key.startsWith(prefix)) personalReads.delete(key)
    }
    invalidate()
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
    } finally {
      // A write may commit even when its response fails. Recovery must read afresh.
      invalidate()
    }
  }
  return {
    taskCommands: createRuntimeTaskCommandsApi(request),
    setTaskPermissions: (userId, deviceId, taskId, taskPermissions) =>
      request('runtime.tasks.permissions.set', { userId, taskId, taskPermissions }, deviceId),
    gitConnection: (deviceId, input) => {
      const { channel, ...payload } = input
      if (channel === 'auth') {
        const { authOperation, ...target } = payload
        if (!['start', 'poll', 'cancel'].includes(String(authOperation)))
          throw new Error('Invalid authorization operation')
        return request(`runtime.local_connector_auth.${String(authOperation)}`, target, deviceId)
      }
      return request(
        channel === 'webhooks'
          ? 'runtime.connections.git.webhooks'
          : channel === 'authTarget'
            ? 'runtime.connections.git.authTarget'
            : 'runtime.connections.git.read',
        payload,
        deviceId
      )
    },
    onboarding: (userId, deviceId, language) =>
      request(
        'runtime.stand_in.onboarding.get',
        { userId, language, timezone: getDeviceTimezone() },
        deviceId
      ),
    completeOnboarding: async (userId, deviceId, weeklyReview, time, language) => {
      const result = await request<StandInOnboardingResult>(
        'runtime.stand_in.onboarding.complete',
        { userId, weeklyReview, time, language, timezone: getDeviceTimezone() },
        deviceId
      )
      if (result.settings) publishPersonalStandIn(result.settings)
      return result
    },
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
    connectionReadiness: (deviceId, providerId, profile, sources) =>
      request(
        'runtime.connections.readiness',
        { providerId, ...(profile ? { profile } : {}), ...(sources ? { sources } : {}) },
        deviceId
      ),
    installConnectionDependencies: (deviceId, providerId, aliases) =>
      installStandInConnectionDependencies({
        deviceId,
        providerId,
        aliases,
        plugins: dependencyPlugins,
        catalog: () => request('runtime.connections.catalog', {}, deviceId),
        installNative: selected =>
          request(
            'runtime.connections.dependencies.install',
            { providerId, aliases: selected },
            deviceId
          ),
      }),
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
    reworkReport: (userId, deviceId, roleId) =>
      request('runtime.stand_in.memory.rework_report', { userId, roleId }, deviceId),
    memoryRules: async (userId, deviceId) =>
      (
        await request<{ items: StandInMemoryRule[] }>(
          'runtime.stand_in.memory.rules.list',
          { userId },
          deviceId
        )
      ).items,
    deleteMemoryRule: async (userId, deviceId, id, version, expectedUpdatedAt) => {
      await request(
        'runtime.stand_in.memory.rules.delete',
        { userId, id, version, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) },
        deviceId
      )
    },
    deleteMemory: async (userId, deviceId, id, version) => {
      await request('runtime.stand_in.memory.delete', { userId, id, version }, deviceId)
    },
    inbox: (userId, deviceId) => request('runtime.stand_in.work.list', { userId }, deviceId),
    remoteRoleBranches: (userId, deviceId, taskId) =>
      request('runtime.stand_in.role_task.branches', { userId, taskId }, deviceId),
    cancelRoleWork: async (userId, deviceId, taskId, root, branchTaskId) => {
      await request(
        'runtime.stand_in.role_task.cancel',
        { userId, taskId, root, branchTaskId },
        deviceId
      )
    },
    retryRoleWork: async (userId, deviceId, taskId, root, branchTaskId, attempt) => {
      await request(
        'runtime.stand_in.role_task.retry',
        { userId, taskId, root, branchTaskId, attempt },
        deviceId
      )
    },
    workMessages: (userId, deviceId, workId) =>
      request('runtime.stand_in.work.messages', { userId, workId }, deviceId),
    takeOverWork: async (userId, deviceId, workId) => {
      await request('runtime.stand_in.work.takeover', { userId, workId }, deviceId)
    },
    verifyWorkDelivery: async (userId, deviceId, workId, recordId) => {
      await request('runtime.stand_in.work.verify_delivery', { userId, workId, recordId }, deviceId)
    },
    runWork: (userId, deviceId, workId, options) =>
      request('runtime.stand_in.work.run', { userId, workId, ...options }, deviceId),
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
    searchConnectionResources: (deviceId, providerId, kind, query, cursor, scope, profile) =>
      request(
        'runtime.connections.resources',
        {
          providerId,
          kind,
          query,
          cursor,
          ...(scope ? { scope } : {}),
          ...(profile ? { profile } : {}),
        },
        deviceId
      ),
    conversation: (userId, deviceId, message, roleId, options) =>
      request('runtime.stand_in.conversation', { userId, message, roleId, options }, deviceId),
    projectProcessing: (userId, deviceId, target, check = false) =>
      request(
        check
          ? 'runtime.project_coordinator.processing.check'
          : 'runtime.project_coordinator.processing.get',
        { userId, ...target },
        deviceId
      ),
    projectCoordination: (userId, deviceId, target, update) =>
      request(
        update === undefined
          ? 'runtime.project_coordinator.binding.get'
          : 'runtime.project_coordinator.binding.save',
        { userId, ...target, ...(update === undefined ? {} : { binding: update }) },
        deviceId
      ),
    projectConversation: (userId, deviceId, projectId, projectStore, groupId, message, options) =>
      request(
        'runtime.project_coordinator.conversation',
        { userId, projectId, projectStore, groupId, message, options },
        deviceId
      ),
    proposal: (userId, deviceId, roleId) =>
      request('runtime.stand_in.proposal.get', { userId, roleId }, deviceId),
    runLearning: (userId, deviceId, roleId) =>
      request('runtime.stand_in.learning.run', { userId, roleId }, deviceId),
    learningReport: async (userId, deviceId, roleId) => {
      const report = await request<StandInLearningReport | null>(
        'runtime.stand_in.proposal.get',
        { userId, roleId, learningReport: true },
        deviceId
      )
      const revision = report?.revision
      if (
        !report ||
        !Number.isInteger(report.iterations) ||
        (revision && (!revision.id?.startsWith('ghost:') || !Number.isInteger(revision.version)))
      ) {
        throw new Error(getStandInErrorMessage({ code: 'stand_in_unavailable' }))
      }
      return report
    },
    resolveProposal: async (userId, deviceId, proposalId, accept, undoVersion) => {
      const saved = await request<PersonalStandInSettings>(
        'runtime.stand_in.proposal.resolve',
        { userId, proposalId, accept, ...(undoVersion !== undefined ? { undoVersion } : {}) },
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
    sharing: {
      list: (userId, deviceId) => request('runtime.stand_in.share.list', { userId }, deviceId),
      searchUsers: (userId, deviceId, query) =>
        request('runtime.stand_in.share.search_users', { userId, query }, deviceId),
      definition: (userId, deviceId, kind, id) =>
        request('runtime.stand_in.share.definition', { userId, kind, id }, deviceId),
      publish: async (userId, deviceId, share) => {
        await request('runtime.stand_in.share.publish', { userId, share }, deviceId)
      },
      direct: async (userId, deviceId, entry) => {
        await request(
          'runtime.stand_in.share.direct',
          {
            userId,
            ownerUserId: entry.owner_user_id,
            kind: entry.resource_kind,
            id: entry.source_id,
          },
          deviceId
        )
      },
      revoke: async (userId, deviceId, entry) => {
        await request(
          'runtime.stand_in.share.revoke',
          {
            userId,
            kind: entry.resource_kind,
            id: entry.source_id,
            recipientUserId: entry.recipient_user_id,
          },
          deviceId
        )
      },
      copy: async (userId, deviceId, entry, update = false) => {
        const settings = await request<PersonalStandInSettings>(
          'runtime.stand_in.share.copy',
          {
            userId,
            ownerUserId: entry.owner_user_id,
            kind: entry.resource_kind,
            id: entry.source_id,
            expectedRevision: entry.revision,
            update,
          },
          deviceId
        )
        publishPersonalStandIn(settings)
        return settings
      },
    },
    deviceIdentity: deviceId => request('runtime.stand_in.device_identity', {}, deviceId),
    personalGet: (userId, deviceId) => {
      const key = JSON.stringify([userId, deviceId])
      const pending = personalReads.get(key)
      if (pending) return pending
      const result = request<PersonalStandInSettings>(
        'runtime.stand_in.personal.get',
        { userId },
        deviceId
      )
      personalReads.set(key, result)
      const clear = () => {
        if (personalReads.get(key) === result) personalReads.delete(key)
      }
      void result.then(clear, clear)
      return result
    },
    binding: (deviceId, operation = 'get', version, target) =>
      request('runtime.stand_in.binding', { operation, version, target }, deviceId),
    lifecycle: async (userId, deviceId, operation, expectedVersion) => {
      const saved = await request<PersonalStandInSettings>(
        'runtime.stand_in.personal.lifecycle',
        expectedVersion === undefined
          ? { userId, operation }
          : {
              userId,
              operation: operation === 'stop' ? 'stopIfVersion' : 'startIfVersion',
              expectedVersion,
            },
        deviceId
      )
      publishPersonalStandIn(saved)
      return saved
    },
    personalSave: async (userId, settings, deviceId, transferRoleId) => {
      const saved = await request<PersonalStandInSettings>(
        'runtime.stand_in.personal.save',
        { userId, settings, ...(transferRoleId !== undefined ? { transferRoleId } : {}) },
        deviceId
      )
      publishPersonalStandIn(saved)
      return saved
    },
    saveDelegationRoute: async (userId, deviceId, version, roleId, route) => {
      const saved = await request<PersonalStandInSettings>(
        'runtime.stand_in.personal.save',
        { userId, delegationRoute: { version, roleId, route } },
        deviceId
      )
      publishPersonalStandIn(saved)
      return saved
    },
    readTask: async (deviceId, taskId, options) => {
      try {
        return await request<Awaited<ReturnType<StandInExecutorApi['readTask']>>>(
          'runtime.tasks.get',
          { taskId, ...(options?.resolveActiveProvider ? { resolveActiveProvider: true } : {}) },
          deviceId
        )
      } catch (error) {
        // A missing first conversation is an empty lookup on both transports.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'task_not_found'
        )
          return { success: false, code: 'task_not_found' }
        throw error
      }
    },
    assignmentTasks: (userId, deviceId, assignments) =>
      request('runtime.stand_in.assignment_tasks', { userId, assignments }, deviceId),
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
