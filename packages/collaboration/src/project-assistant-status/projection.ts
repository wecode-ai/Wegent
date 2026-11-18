import type {
  AssistantAssignmentState,
  AssistantAvailability,
  HostingReasonCode,
  ProjectAssistantManagerSummary,
  ProjectAssistantReceipt,
  ProjectAssistantStatus,
} from './types'

const availabilityValues = ['online', 'offline', 'unknown'] as const
const reasonValues = [
  'not_enabled',
  'hosting_paused',
  'tag_mismatch',
  'device_offline',
  'permission_revoked',
  'execution_failed',
  'unknown',
] as const
const assignmentValues = [
  'queued',
  'waiting_device',
  'blocked_policy',
  'running',
  'completed',
  'failed',
  'unknown',
] as const

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function timestamp(value: unknown): string | null {
  const result = text(value)
  return result && Number.isFinite(Date.parse(result)) ? result : null
}

function tags(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((tag) => text(tag) ?? []) : []
}

function availability(value: unknown): AssistantAvailability {
  return availabilityValues.includes(value as AssistantAvailability)
    ? (value as AssistantAvailability)
    : 'unknown'
}

function receiptProjection(value: unknown): ProjectAssistantReceipt | null {
  const receipt = record(value)
  const runtime = record(receipt?.runtimeTaskRef)
  const humanAssignmentId = text(receipt?.humanAssignmentId)
  const deviceId = text(runtime?.deviceId)
  const taskId = text(runtime?.taskId)
  if (!receipt || !humanAssignmentId || !deviceId || !taskId) return null
  return {
    humanAssignmentId,
    runtimeTaskRef: { deviceId, taskId },
    state: assignmentValues.includes(receipt.state as AssistantAssignmentState)
      ? (receipt.state as AssistantAssignmentState)
      : 'unknown',
    receivedAt: timestamp(receipt.receivedAt),
    deliveryRef: text(receipt.deliveryRef),
    traceRef: text(receipt.traceRef),
  }
}

/** Whitelist a proposed server DTO. This adapter performs no authorization. */
export function projectAssistantStatus(
  value: unknown,
): ProjectAssistantStatus | null {
  const snapshot = record(value)
  if (!snapshot || snapshot.source !== 'server_projection') return null
  if (
    typeof snapshot.version !== 'number' ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1
  )
    return null
  const projectId = text(snapshot.projectId)
  const ownerUserId = text(snapshot.ownerUserId)
  const roleId = text(snapshot.roleId)
  const projectStore = snapshot.projectStore
  if (
    !projectId ||
    !ownerUserId ||
    !roleId ||
    typeof snapshot.enabled !== 'boolean'
  )
    return null
  if (projectStore !== 'local' && projectStore !== 'cloud') return null
  const receipt = receiptProjection(snapshot.receipt)
  const scope = record(snapshot.scope)
  return {
    source: 'server_projection',
    synthetic: snapshot.synthetic === true,
    projectStore,
    projectId,
    ownerUserId,
    roleId,
    enabled: snapshot.enabled,
    scope: {
      kind:
        scope?.kind === 'project' || scope?.kind === 'tags'
          ? scope.kind
          : 'unknown',
      tagIds: tags(scope?.tagIds),
    },
    currentTags: tags(snapshot.currentTags),
    tagMatch: typeof snapshot.tagMatch === 'boolean' ? snapshot.tagMatch : null,
    dispatchable:
      typeof snapshot.dispatchable === 'boolean' ? snapshot.dispatchable : null,
    endpointRef: text(snapshot.endpointRef),
    availability: availability(snapshot.availability),
    // One verified timestamp is shared by the card and its receipt detail.
    lastReceiptAt: receipt?.receivedAt ?? null,
    reasonCode:
      snapshot.reasonCode === null
        ? null
        : reasonValues.includes(snapshot.reasonCode as HostingReasonCode)
          ? (snapshot.reasonCode as HostingReasonCode)
          : 'unknown',
    version: snapshot.version,
    receipt,
  }
}

/** Accept the minimal project-owner DTO without requesting a private self DTO. */
export function projectAssistantManagerSummary(
  value: unknown,
): ProjectAssistantManagerSummary {
  const snapshot = record(value)
  return {
    dispatchable:
      typeof snapshot?.dispatchable === 'boolean'
        ? snapshot.dispatchable
        : null,
    availability: availability(snapshot?.availability),
  }
}

export function formatReceiptTime(
  value: string | null,
  missingLabel: string,
  locale = 'en',
  timeZone = 'Asia/Shanghai',
): string {
  if (!timestamp(value)) return missingLabel
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(new Date(value as string))
}

export function hostingRecoveryAction(reason: HostingReasonCode | null) {
  if (
    reason === 'not_enabled' ||
    reason === 'hosting_paused' ||
    reason === 'device_offline'
  )
    return 'settings'
  if (reason === 'tag_mismatch' || reason === 'permission_revoked')
    return 'rules'
  if (reason === 'execution_failed') return 'receipt'
  return null
}
