import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { isPendingRequestUserInputBlock } from '@/components/chat/requestUserInputMessages'
import type { WorkbenchMessage } from '@/types/workbench'

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
  return null
}
