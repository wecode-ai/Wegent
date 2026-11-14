import type { ProjectChatMessage } from '@wegent/chat-core'
import { canStartWorkOnCollaborationIssue, markdownAttachmentRows } from '@wegent/collaboration'
import type { RuntimeTaskAddress } from '@/types/api'
import { selectPrivateConversations } from './conversationSelectors'
import { mergeHistoryNodes, selectHistoryNodes } from './historySelectors'
import {
  knownRuntimeAddress,
  matchesExperienceViewer,
  projectViewer,
  runtimeAddressKey,
  validSourceTimestamp,
} from './sourceIdentity'
import type {
  ExperienceConversationSelection,
  ExperienceTimeline,
  ExperienceTimelineInput,
  ExperienceTimelineNode,
} from './types'

type MessageIndex = ReadonlyMap<string, ProjectChatMessage>

function scopedMessages(input: ExperienceTimelineInput): ProjectChatMessage[] {
  const messages = new Map<string, ProjectChatMessage>()
  for (const message of input.messages ?? []) {
    if (message.projectId !== input.project.id || message.taskId !== input.issue?.id) continue
    const previous = messages.get(message.messageId)
    if (!previous) messages.set(message.messageId, message)
    else
      messages.set(message.messageId, {
        ...(message.updatedAt >= previous.updatedAt ? message : previous),
        sequenceNumber: Math.min(previous.sequenceNumber, message.sequenceNumber),
      })
  }
  return [...messages.values()].sort(
    (left, right) =>
      left.sequenceNumber - right.sequenceNumber || left.messageId.localeCompare(right.messageId)
  )
}

function humanSource(message: ProjectChatMessage, index: MessageIndex): ProjectChatMessage | null {
  if (message.sender.type === 'user') return message
  const trigger = message.triggerMessageId ? index.get(message.triggerMessageId) : null
  return trigger?.sender.type === 'user' ? trigger : null
}

function sourceAddresses(message: ProjectChatMessage, index: MessageIndex): RuntimeTaskAddress[] {
  const sources = [message]
  if (message.sender.type === 'user')
    for (const candidate of index.values()) {
      if (candidate.sender.type === 'agent' && candidate.triggerMessageId === message.messageId)
        sources.push(candidate)
    }
  return sources.flatMap(source =>
    knownRuntimeAddress(source.runtimeAddress) ? [source.runtimeAddress] : []
  )
}

function nodeConversations(
  message: ProjectChatMessage,
  index: MessageIndex,
  input: ExperienceTimelineInput,
  available: ExperienceConversationSelection
): ExperienceConversationSelection {
  const owner = humanSource(message, index)
  if (!owner) return { state: 'unknown', items: [] }
  const viewer = projectViewer(input.project, input.viewer, input.participationViewer)
  if (typeof viewer === 'object' && viewer.length === 0) return { state: 'unknown', items: [] }
  if (!matchesExperienceViewer(owner.sender.id, viewer)) return { state: 'hidden', items: [] }
  const keys = new Set(sourceAddresses(message, index).map(runtimeAddressKey))
  const turnId =
    typeof message.metadata.runtime_turn_id === 'string'
      ? message.metadata.runtime_turn_id.trim() || null
      : null
  const items = available.items
    .filter(item => keys.has(item.key))
    .map(item => ({
      ...item,
      address: { ...item.address },
      bindingIds: [...item.bindingIds],
      sourceNodeIds: [...new Set([...item.sourceNodeIds, message.messageId])],
      historySource: {
        turnId,
        userMessageIds: [
          ...new Set(
            [owner.messageId, owner.clientMessageId].filter((id): id is string => Boolean(id))
          ),
        ],
      },
    }))
  return { state: items.length ? 'ready' : 'unknown', items }
}

function timelineNode(
  message: ProjectChatMessage,
  index: MessageIndex,
  input: ExperienceTimelineInput,
  conversations: ExperienceConversationSelection
): ExperienceTimelineNode {
  const kind =
    message.sender.type === 'agent'
      ? 'execution'
      : message.sender.type === 'user'
        ? 'comment'
        : 'system'
  const owner = humanSource(message, index)
  const attachments = new Map(
    (kind === 'execution' ? [] : markdownAttachmentRows(message.content)).map(attachment => [
      attachment.id,
      {
        id: attachment.id,
        name: attachment.display_name,
        sourceNodeId: message.messageId,
      },
    ])
  )
  return {
    id: message.messageId,
    clientMessageId: message.clientMessageId ?? null,
    sequenceNumber: message.sequenceNumber,
    kind,
    at: validSourceTimestamp(message.createdAt),
    body: kind === 'execution' ? null : message.content,
    author: owner ? { id: owner.sender.id, name: owner.sender.name } : null,
    status: message.status,
    attachments: [...attachments.values()],
    conversation: nodeConversations(message, index, input, conversations),
    executionAddress:
      kind === 'execution' && knownRuntimeAddress(message.runtimeAddress)
        ? {
            deviceId: message.runtimeAddress.deviceId,
            taskId: message.runtimeAddress.taskId,
          }
        : null,
  }
}

export function selectTaskTimeline(input: ExperienceTimelineInput): ExperienceTimeline {
  if (!input.issue || input.issue.cloud_project_id !== input.project.id)
    return { state: 'unknown', nodes: [] }
  if (!canStartWorkOnCollaborationIssue(input.issue)) return { state: 'hidden', nodes: [] }
  if (!input.messages) return { state: 'unknown', nodes: [] }
  const messages = scopedMessages(input)
  const index = new Map(messages.map(message => [message.messageId, message]))
  const conversations = selectPrivateConversations(input)
  return {
    state: 'ready',
    nodes: mergeHistoryNodes(
      messages.map(message => timelineNode(message, index, input, conversations)),
      selectHistoryNodes(input)
    ),
  }
}
