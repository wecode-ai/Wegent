import type { ProcessingBlock, WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { getGeneratedImages } from '@wegent/chat-core/generated-images'
import {
  isAnsweredRequestUserInputBlock,
  isAsyncRequestUserInputPayload,
  isDeliveredRequestUserInputReply,
  isRequestUserInputBlock,
  type RequestUserInputBlock,
} from '@wegent/chat-core/runtime-user-input'
import {
  getAssistantContentPresentation,
  getAssistantRenderProjection,
  isCancelledAssistantMessage,
} from './assistantMessagePresentation'
import { isHostActivityMessage } from './standInActivity'

function isAnsweredQuestion(block: ProcessingBlock): block is RequestUserInputBlock {
  if (!isRequestUserInputBlock(block) || !isAnsweredRequestUserInputBlock(block)) return false
  const payload = block.renderPayload
  const kind = payload.interactionKind ?? payload.interaction_kind
  return (
    block.status !== 'error' &&
    (!kind || kind === 'question') &&
    payload.interactionStatus !== 'cancelled' &&
    payload.interactionStatus !== 'expired'
  )
}

/** Hide redundant question summaries only after a later assistant reply is visible. */
export function hideAnsweredQuestionSummaries(messages: WorkbenchMessage[]): WorkbenchMessage[] {
  const visible = [...messages]
  const turnsWithResult = new Set<string>()
  let resultBeforeNextUser = false
  let resultAfterNextAnswer = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') {
      if (isDeliveredRequestUserInputReply(message)) {
        resultAfterNextAnswer =
          !isHostActivityMessage(message) &&
          (message.turnId ? turnsWithResult.has(message.turnId) : resultBeforeNextUser)
      }
      resultBeforeNextUser = false
      continue
    }
    if (message.role !== 'assistant') continue

    const canShowResult = message.status !== 'failed' && !isCancelledAssistantMessage(message)
    const hasTextResult =
      canShowResult && Boolean(getAssistantContentPresentation(message).content.trim())
    const imageResults = new Set(
      canShowResult && message.blocks?.length
        ? getGeneratedImages(
            message.blocks.filter(block => block.status === 'done'),
            ''
          ).map(image => image.id)
        : []
    )
    if (message.blocks?.some(isAnsweredQuestion)) {
      let resultFollows = message.turnId
        ? turnsWithResult.has(message.turnId)
        : resultBeforeNextUser
      const hiddenIds = new Set<string>()
      for (const segment of getAssistantRenderProjection(message).segments.toReversed()) {
        if (segment.kind === 'content') {
          resultFollows ||= hasTextResult && Boolean(segment.content.trim())
          continue
        }
        for (const block of segment.blocks.toReversed()) {
          if (imageResults.has(block.id)) resultFollows = true
          if (
            isAnsweredQuestion(block) &&
            (resultFollows ||
              (resultAfterNextAnswer && isAsyncRequestUserInputPayload(block.renderPayload)))
          ) {
            hiddenIds.add(block.id)
          }
        }
      }
      if (hiddenIds.size) {
        visible[index] = {
          ...message,
          blocks: message.blocks.filter(block => !hiddenIds.has(block.id)),
          runtimeDisplayItems: message.runtimeDisplayItems?.filter(item => !hiddenIds.has(item.id)),
        }
      }
    }
    if (hasTextResult || imageResults.size) {
      if (message.turnId) turnsWithResult.add(message.turnId)
      resultBeforeNextUser = true
    }
  }
  return visible
}
