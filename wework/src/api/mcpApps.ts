import type { AppBridge, McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { RuntimeTaskAddress } from '@/types/api'

export type McpAppTool = NonNullable<McpUiHostContext['toolInfo']>['tool']
export type McpAppResult = Parameters<AppBridge['sendToolResult']>[0]
export type McpAppResource = Awaited<ReturnType<NonNullable<AppBridge['onreadresource']>>>
export interface McpAppDescriptor {
  resource: McpAppResource
  resourceUri: string
  tool: McpAppTool | null
  server: string
  arguments: Record<string, unknown>
  result: McpAppResult | null
  preferredDisplayMode?: 'inline' | 'fullscreen' | null
}
export interface McpAppRequest {
  address: RuntimeTaskAddress
  callId: string
  method?: string
  params?: Record<string, unknown>
  approved?: boolean
}
export interface RuntimeMcpAppsApi {
  requestMcpApp: <T = unknown>(data: McpAppRequest) => Promise<T>
}
