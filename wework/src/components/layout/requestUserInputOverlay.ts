import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  CODEX_IMPLEMENT_PLAN_QUESTION,
  CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL,
  isPendingRequestUserInputBlock,
} from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'

export function pendingRequestUserInputPayload(
  messages: WorkbenchMessage[],
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputPayload | null {
  for (const message of [...messages].reverse()) {
    if (message.role === 'user' && message.content.trim()) {
      return null
    }

    for (const block of [...(message.blocks ?? [])].reverse()) {
      if (!isPendingRequestUserInputBlock(block, hiddenRequestUserInputIds)) continue
      return block.renderPayload as RequestUserInputPayload
    }

    const planPayload = pendingImplementationPlanPayload(message, hiddenRequestUserInputIds)
    if (planPayload) return planPayload
  }
  return null
}

function pendingImplementationPlanPayload(
  message: WorkbenchMessage,
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputPayload | null {
  if (message.role !== 'assistant' || message.status === 'streaming') return null

  const planBlock = [...(message.blocks ?? [])]
    .reverse()
    .find(
      block => block.type === 'plan' && block.status === 'done' && Boolean(block.content.trim())
    )
  if (!planBlock) return null

  const itemId = `implementation-plan:${message.id}:${planBlock.id}`
  if (hiddenRequestUserInputIds?.has(`item:${itemId}`)) return null

  return {
    kind: 'request_user_input',
    itemId,
    questions: [
      {
        id: 'implement',
        question: CODEX_IMPLEMENT_PLAN_QUESTION,
        options: [{ label: CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL }],
      },
      {
        id: 'adjustment',
        question: '否，请告知 WeWork 如何调整',
        is_other: true,
      },
    ],
  }
}
