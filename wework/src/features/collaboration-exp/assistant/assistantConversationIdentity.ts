import { standInConversationTaskId } from '@/api/personalStandIn'
import type { StandInInboxWork } from '@/api/standIn'
import type { RuntimeTaskAddress, RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import type { ExperiencePrivateConversation } from '../model'

export interface AssistantConversationSource {
  ownerUserId: number
  inboxDeviceId?: string
  inbox: readonly StandInInboxWork[]
  runtimeWork: RuntimeWorkListResponse | null | undefined
  accepted?: ExperiencePrivateConversation | null
}

function fromMetadata(
  source: AssistantConversationSource,
  address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>,
  task: RuntimeTaskSummary | null,
  inbox?: StandInInboxWork
): ExperiencePrivateConversation | null {
  const metadata = task ?? inbox?.task ?? null
  if (metadata && metadata.taskId !== address.taskId) return null
  const rawOrigin = metadata?.runtimeHandle?.origin as Record<string, unknown> | undefined
  if (
    rawOrigin?.cloudProjectId ||
    rawOrigin?.loopItemId ||
    rawOrigin?.publicConversation === true ||
    rawOrigin?.type === 'issue_dispatch'
  )
    return null
  if (
    rawOrigin &&
    ((rawOrigin.userId !== undefined && rawOrigin.userId !== source.ownerUserId) ||
      (rawOrigin.deviceId !== undefined && rawOrigin.deviceId !== address.deviceId))
  )
    return null
  const origin =
    rawOrigin?.userId === source.ownerUserId && rawOrigin.deviceId === address.deviceId
      ? rawOrigin
      : null
  const roleId = typeof origin?.standInId === 'string' ? origin.standInId : undefined
  const identity =
    origin?.type === 'stand_in_identity' &&
    origin.initiatedBy === 'stand_in_identity' &&
    origin.runtimeTaskId === address.taskId &&
    address.taskId === standInConversationTaskId(source.ownerUserId, roleId)
  const delegated =
    origin?.type === 'stand_in_task' &&
    origin.initiatedBy === 'stand_in' &&
    typeof origin.sourceTaskId === 'string' &&
    origin.sourceTaskId ===
      standInConversationTaskId(
        source.ownerUserId,
        roleId === '@primary' || roleId === 'default' ? undefined : roleId
      )
  const accepted =
    source.accepted?.ownerUserId === source.ownerUserId &&
    source.accepted.address.deviceId === address.deviceId &&
    source.accepted.address.taskId === address.taskId
      ? source.accepted
      : null
  if (!identity && !delegated && !inbox && !accepted) return null
  const resolved: RuntimeTaskAddress = {
    deviceId: address.deviceId,
    taskId: address.taskId,
    ...(metadata
      ? {
          runtime: metadata.runtime,
          threadId: metadata.threadId,
          workspacePath: metadata.workspacePath,
          workspaceKind: metadata.workspaceKind,
          runtimeHandle: metadata.runtimeHandle,
        }
      : {}),
  }
  const timestamp = metadata?.updatedAt ?? inbox?.updatedAt
  const at = timestamp == null ? null : new Date(timestamp)
  return {
    key: JSON.stringify([resolved.deviceId, resolved.taskId]),
    ownerUserId: source.ownerUserId,
    address: metadata ? resolved : (accepted?.address ?? resolved),
    bindingIds: [],
    sourceNodeIds: [],
    title: metadata?.title ?? inbox?.title ?? accepted?.title ?? null,
    linkedAt: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
  }
}

function workspaces(source: AssistantConversationSource) {
  return [
    ...(source.runtimeWork?.chats ?? []),
    ...(source.runtimeWork?.projects.flatMap(project => project.deviceWorkspaces) ?? []),
  ]
}

/** Query addresses select existing owned metadata; they never authorize a history read. */
export function selectAssistantConversation(
  source: AssistantConversationSource,
  address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>
): ExperiencePrivateConversation | null {
  const task =
    workspaces(source)
      .find(
        workspace =>
          workspace.deviceId === address.deviceId &&
          workspace.tasks.some(task => task.taskId === address.taskId)
      )
      ?.tasks.find(task => task.taskId === address.taskId) ?? null
  const inbox =
    address.deviceId === source.inboxDeviceId
      ? source.inbox.find(item => item.taskId === address.taskId)
      : undefined
  return fromMetadata(source, address, task, inbox)
}

export function selectAssistantConversations(
  source: AssistantConversationSource
): ExperiencePrivateConversation[] {
  const conversations = new Map<string, ExperiencePrivateConversation>()
  const seen = new Set<string>()
  const inbox = new Map(source.inbox.map(item => [item.taskId, item]))
  for (const workspace of workspaces(source))
    for (const task of workspace.tasks) {
      seen.add(JSON.stringify([workspace.deviceId, task.taskId]))
      const conversation = fromMetadata(
        source,
        { deviceId: workspace.deviceId, taskId: task.taskId },
        task,
        workspace.deviceId === source.inboxDeviceId ? inbox.get(task.taskId) : undefined
      )
      if (conversation) conversations.set(conversation.key, conversation)
    }
  if (source.inboxDeviceId)
    for (const item of source.inbox) {
      const address = { deviceId: source.inboxDeviceId, taskId: item.taskId }
      const key = JSON.stringify([address.deviceId, address.taskId])
      if (seen.has(key)) continue
      const conversation = fromMetadata(source, address, item.task ?? null, item)
      if (conversation) conversations.set(key, conversation)
    }
  return [...conversations.values()]
}
