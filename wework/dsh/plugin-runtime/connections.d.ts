import type { Context } from '@deepseek-ai/cordis'

export interface CodexConnectionDependency {
  kind: 'codexPlugin'
  source: { marketplaceId: string; pluginId: string }
  version: string
}

export interface ConnectionDescriptor {
  id: string
  displayName: string
  uses: string[]
  collectionModes: ['poll']
  resourceKinds: string[]
  resourceLabels: Record<string, string>
  locales?: Record<string, { displayName?: string; resourceLabels?: Record<string, string> }>
  eventTypes: string[]
  /** Read contract for existing tools without readOnlyHint; explicit false always wins. */
  mcpReadTools?: Record<string, Array<{ server: string; tool: string }>>
  cliReadTools?: Record<string, ConnectionCliDeclaration>
  authTarget?: { pluginKey: string; connectorSlug: string }
}

export interface ConnectionDefinition {
  apiVersion: 1
  packageName: string
  dependencies: Record<string, CodexConnectionDependency>
  providers: ConnectionDescriptor[]
}

export interface InstalledConnectionDependency {
  marketplaceId: string
  pluginId: string
  name: string
  installed: boolean
  enabled: boolean
  version: string | null
  marketplacePath?: string | null
  availability?: string
}

export interface ConnectionDependencyResolution extends CodexConnectionDependency {
  alias: string
  status: 'ready' | 'missing' | 'disabled' | 'incompatible' | 'unavailable'
  resolved: InstalledConnectionDependency | null
}

export interface ConnectionResource {
  providerId: string
  id: string
  profile: string
  kind: string
  name: string
  [key: string]: unknown
}

export interface ConnectionSource extends ConnectionResource {
  enabledAfter: string
  policy: { automatic: boolean; askBeforeAct: boolean }
}

export interface ConnectionResourceQuery {
  kind: string
  query: string
  cursor?: string
}

export interface ConnectionResourcePage {
  items: ConnectionResource[]
  hasMore?: boolean
  nextCursor?: string
}

export interface ConnectionEvent {
  id: string
  text: string
  at: string
  eventType: string
  senderId?: string
  senderName?: string | null
  quotedMessageId?: string | null
  topicId?: string | null
  [key: string]: unknown
}

export type ConnectionCheckpoint = Record<string, unknown>
export interface ConnectionPage {
  events: ConnectionEvent[]
  nextCheckpoint: ConnectionCheckpoint
  hasMore: boolean
}

export interface ConnectionAvailability {
  status: 'ready' | 'auth_required' | 'error'
  code?: string
}

export interface ConnectionContext {
  providerId: string
  signal: AbortSignal
  dependencies: ReadonlyArray<ConnectionDependencyResolution>
  /** Direct MCP calls use a host-owned ephemeral thread; no model turn is started. */
  mcp: {
    listTools(dependency: string): Promise<{ tools: ConnectionMcpTool[] }>
    callTool(
      dependency: string,
      input: {
        server: string
        tool: string
        arguments?: Record<string, unknown>
      }
    ): Promise<ConnectionMcpResult>
  }
  cli: {
    callTool(
      dependency: string,
      input: { tool: string; arguments?: Record<string, string> }
    ): Promise<unknown>
  }
}

export interface ConnectionCliDeclaration {
  connectorSlug: string
  outputArgs: string[]
  operations: Record<string, { command: string[]; parameters: Record<string, string> }>
}

export interface ConnectionMcpTool {
  server: string
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface ConnectionMcpResult {
  content: unknown[]
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

export interface ConnectionProvider {
  check(context: ConnectionContext): Promise<ConnectionAvailability>
  listResources(
    context: ConnectionContext,
    input: ConnectionResourceQuery
  ): Promise<ConnectionResourcePage>
  validate(context: ConnectionContext, input: ConnectionSource): Promise<unknown>
  initialize(context: ConnectionContext, input: ConnectionSource): Promise<ConnectionCheckpoint>
  collect(
    context: ConnectionContext,
    input: { source: ConnectionSource; checkpoint: ConnectionCheckpoint }
  ): Promise<ConnectionPage>
}

export interface WeworkConnectionsService {
  register(
    owner: Context,
    manifestUrl: URL,
    providers: Record<string, ConnectionProvider>
  ): Promise<() => void>
}

export declare function parseConnections(manifest: unknown): ConnectionDefinition | null
export declare function dependencyPlan(
  definition: ConnectionDefinition,
  inventory: InstalledConnectionDependency[],
  satisfies: (version: string, range: string) => boolean
): ConnectionDependencyResolution[]
export declare class ConnectionError extends Error {
  code: string
}
