/** Design contracts only. These types are not connected to a Backend API. */
export type ProjectStore = 'local' | 'cloud'

export interface ProjectAssistantScope {
  projectStore: ProjectStore
  projectId: string
}

export type AssistantAvailability = 'online' | 'offline' | 'unknown'
export type HostingReasonCode =
  | 'not_enabled'
  | 'hosting_paused'
  | 'tag_mismatch'
  | 'device_offline'
  | 'permission_revoked'
  | 'execution_failed'
  | 'unknown'

export type AssistantAssignmentState =
  | 'queued'
  | 'waiting_device'
  | 'blocked_policy'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown'

export interface ProjectAssistantReceipt {
  humanAssignmentId: string
  runtimeTaskRef: { deviceId: string; taskId: string }
  state: AssistantAssignmentState
  receivedAt: string | null
  deliveryRef: string | null
  traceRef: string | null
}

/** A read-only projection; local settings and notifications cannot create it. */
export interface ProjectAssistantStatus extends ProjectAssistantScope {
  source: 'server_projection'
  synthetic: boolean
  ownerUserId: string
  roleId: string
  enabled: boolean
  scope: { kind: 'project' | 'tags' | 'unknown'; tagIds: string[] }
  /** Tags of the current Issue/assignment context, never all project tags. */
  currentTags: string[]
  /** Server match result; null when no Issue/assignment context is available. */
  tagMatch: boolean | null
  dispatchable: boolean | null
  endpointRef: string | null
  availability: AssistantAvailability
  lastReceiptAt: string | null
  reasonCode: HostingReasonCode | null
  version: number
  receipt: ProjectAssistantReceipt | null
}

/** Project owners receive only these two server-provided orchestration facts. */
export interface ProjectAssistantManagerSummary {
  dispatchable: boolean | null
  availability: AssistantAvailability
}

export interface ProjectAssistantStatusCopy {
  ownerHeading: string
  managerHeading: string
  projectFallback: string
  enabled: string
  notEnabled: string
  paused: string
  revoked: string
  loading: string
  loadingDetail: string
  refreshing: string
  refreshingDetail: string
  error: string
  errorDetail: string
  staleDetail: string
  retryAction: string
  unknown: string
  unknownDetail: string
  dispatchable: string
  yes: string
  no: string
  pending: string
  scope: string
  projectScope: string
  tagScope: string
  scopeUnknown: string
  coveredTags: string
  allTags: string
  currentTags: string
  noTags: string
  matched: string
  unmatched: string
  tagMatchUnknown: string
  availability: string
  availabilityValues: Record<AssistantAvailability, string>
  lastReceipt: string
  noReceiptTime: string
  assignment: string
  noReceipt: string
  incompleteEvidence: string
  incompleteEvidenceDetail: string
  enabledPolicy: string
  pausedPolicy: string
  fixtureNote: string
  projectionNote: string
  settingsAction: string
  rulesAction: string
  receiptAction: string
  reasonLabels: Record<HostingReasonCode, string>
  reasonDetails: Record<HostingReasonCode, string>
  assignmentStates: Record<AssistantAssignmentState, string>
}
