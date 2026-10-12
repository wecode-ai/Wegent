import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { ReplyPredictionSource, ReplyPredictionTurn } from './replyPredictionService'

export function projectReplyPrediction(
  scope: string,
  messages: ProjectChatMessage[],
  busy = false
): ReplyPredictionSource {
  const relevant = messages.filter(
    message => message.sender.type !== 'system' && message.type !== 'agent_status'
  )
  const turns: ReplyPredictionTurn[] = []
  for (const message of relevant) {
    if (message.sender.type === 'user') {
      turns.push({
        id: message.messageId,
        status: message.status,
        user: message.content,
        assistant: '',
      })
    } else {
      let turn = turns.at(-1)
      if (!turn) {
        turn = { id: message.messageId, status: message.status, user: '', assistant: '' }
        turns.push(turn)
      }
      turn.assistant += `${turn.assistant ? '\n' : ''}${message.content}`
      turn.status = message.status
      turn.id = message.messageId
    }
  }
  const latest = relevant.at(-1)
  return {
    scope,
    revision: `${latest?.messageId ?? ''}:${latest?.updatedAt ?? ''}`,
    busy:
      busy ||
      relevant.some(message => message.status === 'pending' || message.status === 'streaming'),
    load: async () => turns,
  }
}
