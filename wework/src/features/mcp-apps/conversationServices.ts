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
  if (!address || !api?.requestMcpApp) return undefined
  return {
    address,
    api: { requestMcpApp: api.requestMcpApp },
    sendMessage: readOnly ? undefined : message => sendMessage({ address, message }),
  }
}
