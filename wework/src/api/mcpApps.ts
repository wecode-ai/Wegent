import type { AppBridge, McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { RuntimeTaskAddress } from '@/types/api'

export type McpAppTool = NonNullable<McpUiHostContext['toolInfo']>['tool']
export type McpAppResult = Parameters<AppBridge['sendToolResult']>[0]
export type McpAppResource = Awaited<ReturnType<NonNullable<AppBridge['onreadresource']>>>
export interface McpAppDiscovery {
  resourceUri: string
  tool: McpAppTool | null
  server: string
  arguments: Record<string, unknown>
  result: McpAppResult | null
  preferredDisplayMode?: 'inline' | 'fullscreen' | null
}
export interface McpAppDescriptor extends McpAppDiscovery {
  resource: McpAppResource
}
export interface McpAppRequest {
  address: RuntimeTaskAddress
  callId: string
  method?: string
  params?: Record<string, unknown>
}
export interface RuntimeMcpAppsApi {
  requestMcpApp: <T = unknown>(data: McpAppRequest) => Promise<T>
}

export interface McpAppConversationServices {
  address: RuntimeTaskAddress
  api: RuntimeMcpAppsApi
  sendMessage?: (message: string) => Promise<boolean>
}
