import type {
  AssistantAssignmentState,
  ProjectAssistantScope,
  ProjectAssistantStatus,
} from './types'

const receivedAt = '2026-11-16T08:00:00Z'
const base: ProjectAssistantStatus = {
  source: 'server_projection',
  synthetic: true,
  projectStore: 'cloud',
  projectId: 'project-example',
  ownerUserId: 'user-example',
  roleId: '@primary',
  enabled: true,
  // The synthetic current assignment has the feature tag; this is not a project tag list.
  scope: { kind: 'project', tagIds: [] },
  currentTags: ['feature'],
  tagMatch: true,
  dispatchable: true,
  endpointRef: 'endpoint-example',
  availability: 'online',
  lastReceiptAt: receivedAt,
  reasonCode: null,
  version: 1,
  receipt: {
    humanAssignmentId: 'assignment-example',
    runtimeTaskRef: { deviceId: 'device-example', taskId: 'task-example' },
    state: 'running',
    receivedAt,
    deliveryRef: null,
    traceRef: 'trace-example',
  },
}

const scenario = (
  overrides: Partial<ProjectAssistantStatus> = {},
): ProjectAssistantStatus => ({ ...base, ...overrides })
const assignment = (
  state: AssistantAssignmentState,
  deliveryRef: string | null = null,
): ProjectAssistantStatus =>
  scenario({
    receipt: { ...base.receipt!, state, deliveryRef },
  })

export const projectAssistantStatusFixtures = {
  scenarios: {
    hosting: scenario(),
    notEnabled: scenario({
      enabled: false,
      dispatchable: false,
      reasonCode: 'not_enabled',
      receipt: null,
      lastReceiptAt: null,
    }),
    tagMismatch: scenario({
      scope: { kind: 'tags', tagIds: ['review'] },
      tagMatch: false,
      dispatchable: false,
      reasonCode: 'tag_mismatch',
      receipt: { ...base.receipt!, state: 'blocked_policy' },
    }),
    waitingDevice: scenario({
      availability: 'offline',
      dispatchable: false,
      reasonCode: 'device_offline',
      receipt: { ...base.receipt!, state: 'waiting_device' },
    }),
    permissionRevoked: scenario({
      dispatchable: false,
      reasonCode: 'permission_revoked',
      receipt: { ...base.receipt!, state: 'blocked_policy' },
    }),
    failed: scenario({
      dispatchable: false,
      reasonCode: 'execution_failed',
      receipt: { ...base.receipt!, state: 'failed' },
    }),
    queued: assignment('queued'),
    blockedPolicy: scenario({
      dispatchable: false,
      reasonCode: 'tag_mismatch',
      receipt: { ...base.receipt!, state: 'blocked_policy' },
    }),
    running: assignment('running'),
    completed: assignment('completed', 'delivery-example'),
    incompleteEvidence: assignment('completed'),
    pausedRunning: scenario({
      enabled: false,
      dispatchable: false,
      reasonCode: 'hosting_paused',
    }),
    paused: scenario({
      enabled: false,
      dispatchable: false,
      reasonCode: 'hosting_paused',
      receipt: {
        ...base.receipt!,
        state: 'completed',
        deliveryRef: 'delivery-example',
      },
    }),
    noReceipt: scenario({ receipt: null, lastReceiptAt: null }),
    unknown: scenario({
      availability: 'unknown',
      dispatchable: null,
      reasonCode: 'unknown',
      receipt: null,
      lastReceiptAt: null,
    }),
  },
  projects: [
    scenario({ projectStore: 'cloud', projectId: 'project-example' }),
    scenario({
      projectStore: 'local',
      projectId: 'project-example',
      availability: 'offline',
      dispatchable: false,
      reasonCode: 'device_offline',
    }),
  ],
}

/** Synthetic lookup deliberately keys by storage owner and project ID together. */
export function getProjectAssistantStatus(
  scope: ProjectAssistantScope,
): ProjectAssistantStatus | null {
  return (
    projectAssistantStatusFixtures.projects.find(
      (snapshot) =>
        snapshot.projectStore === scope.projectStore &&
        snapshot.projectId === scope.projectId,
    ) ?? null
  )
}
