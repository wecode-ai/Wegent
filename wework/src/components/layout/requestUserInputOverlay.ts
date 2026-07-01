import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  CODEX_IMPLEMENT_PLAN_QUESTION,
  CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL,
  isPendingRequestUserInputBlock,
} from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'

const CODEX_PLAN_TAG_PATTERN = /<\/?\s*proposed_plan\s*>/gi
const CODEX_PLAN_SECTION_PATTERN = /^##\s+(Summary|Key Changes|Test Plan|Assumptions)\s*$/im

export function pendingRequestUserInputPayload(
  messages: WorkbenchMessage[],
  hiddenRequestUserInputIds?: ReadonlySet<string>
): RequestUserInputPayload | null {
  for (const message of [...messages].reverse()) {
    for (const block of [...(message.blocks ?? [])].reverse()) {
      if (!isPendingRequestUserInputBlock(block, hiddenRequestUserInputIds)) continue
      return block.renderPayload as RequestUserInputPayload
    }
  }
  return pendingImplementationPlanPayload(messages)
}

function pendingImplementationPlanPayload(
  messages: WorkbenchMessage[]
): RequestUserInputPayload | null {
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.status === 'streaming') {
    return null
  }
  if (!isAssistantPlanContent(lastMessage.content)) return null
  return {
    kind: 'request_user_input',
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

function isAssistantPlanContent(content: string): boolean {
  const normalizedContent = content.replace(CODEX_PLAN_TAG_PATTERN, '').trim()
  return (
    normalizedContent !== content ||
    (/^#\s+.+/m.test(normalizedContent) && CODEX_PLAN_SECTION_PATTERN.test(normalizedContent))
  )
}
