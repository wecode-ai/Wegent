import type { ProjectChatMessage } from '@wegent/chat-core'
import type { ExperienceTimelineNode } from './types'

/** Public assistant text is content; only persisted run evidence identifies execution. */
export function timelineMessageKind(message: ProjectChatMessage): ExperienceTimelineNode['kind'] {
  if (message.sender.type === 'system' || message.type === 'system') return 'system'
  if (message.metadata.execution_dispatch === 'comment_only') return 'comment'
  if (message.type === 'agent_status' || message.type === 'agent_chunk') return 'execution'
  return 'comment'
}

export function isPublishedTimelineConclusion(node: ExperienceTimelineNode): boolean {
  if (node.kind !== 'comment') return false
  if (node.generationSource !== 'ai') return node.generationSource !== 'system'
  return (
    node.confirmationState === 'authorized' ||
    (node.confirmationState === 'not_required' &&
      (node.publicationSource === 'human' || node.publicationSource === 'ai'))
  )
}
