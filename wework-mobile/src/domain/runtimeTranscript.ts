import { projectRuntimePaneTranscript } from '../../../packages/chat-core/src/runtime-transcript-page'
import type { RuntimeTranscriptResponse as CoreTranscript } from '../../../packages/chat-core/src/runtime'
import type { RuntimeTranscriptResponse } from '@/types/runtime'
import { projectRuntimeConversationTurns } from '../../../packages/chat-core/src/runtime-turns'

/** Use the PC cloud-device projection before adapting native presentation. */
export function projectMobileRuntimeTranscript(
  response: CoreTranscript & { taskId: string }
): RuntimeTranscriptResponse {
  if (!Array.isArray(response.turns)) {
    throw new Error('Runtime transcript response is missing canonical turns')
  }
  const page = projectRuntimePaneTranscript(response)
  return {
    ...response,
    turns: page.turns,
    supersededTurnIds: page.supersededTurnIds,
    messages: projectRuntimeConversationTurns(page.turns).map(message => ({
      ...message,
      blocks: message.blocks?.map(block => ({ ...block })),
      runtimeItems: message.runtimeDisplayItems?.filter(item => item.type === 'assistant_text'),
    })),
  }
}
