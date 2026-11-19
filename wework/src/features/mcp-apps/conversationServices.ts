import { isStandInMemoryReviewTask } from '@/lib/runtime-task-visibility'
import type { RuntimeTaskAddress } from '@/types/api'
import type { McpAppConversationServices, RuntimeMcpAppsApi } from '@/api/mcpApps'

/** Read-only execution views never admit new conversation turns through an app. */
export function createMcpAppConversationServices({
  address,
  api,
  readOnly,
  sendMessage,
}: {
  address: RuntimeTaskAddress | null | undefined
  api: Partial<RuntimeMcpAppsApi> | undefined
  readOnly: boolean
  sendMessage: (data: { address: RuntimeTaskAddress; message: string }) => Promise<boolean>
}): McpAppConversationServices | undefined {
  // Memory review exposes only evidence tools, so do not discover apps for its tool calls.
  if (!address || !api?.requestMcpApp || isStandInMemoryReviewTask(address)) return undefined
  return {
    address,
    api: { requestMcpApp: api.requestMcpApp, getMcpAppSessionTarget: api.getMcpAppSessionTarget },
    sendMessage: readOnly ? undefined : message => sendMessage({ address, message }),
  }
}
