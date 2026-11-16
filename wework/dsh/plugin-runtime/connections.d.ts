import type { Context } from '@deepseek-ai/cordis'

export interface CodexConnectionDependency {
  kind: 'codexPlugin'
  source: { marketplaceId: string; pluginId: string }
  alternateSources?: Array<{ marketplaceId: string; pluginId: string }>
  version: string
}

export interface ConnectionDescriptor {
  id: string
  displayName: string
  uses: string[]
  collectionModes: ['poll']
  resourceKinds: string[]
  resourceLabels: Record<string, string>
  /** Public discovery parameters encoded in listResources.query as a JSON object. */
  resourceQuerySchema?: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required?: string[]
    [key: string]: unknown
  }
  allResourceKinds?: string[]
  allResourceLabels?: Record<string, string>
  allResourceLabel?: string
  locales?: Record<string, { displayName?: string; resourceLabels?: Record<string, string> }>
  eventTypes: string[]
  /** Mutable event types must identify the object and its opaque source version. */
  versionedEventTypes: string[]
  /** Business schemas belong to this provider, not the host. */
  read?: {
    inputSchema: Record<string, unknown>
    itemSchema: Record<string, unknown>
    pagination: 'cursor' | 'none'
  }
  /** Domain guidance, scoped to current connections; never permissions or global instructions. */
  assistance?: {
    observe: string[]
    prepare: string[]
    notifyWhen: string[]
    confirmBefore: string[]
  }
  /** Declared operations remain subject to native host authorization on every call. */
  actions?: Array<{
    id: string
    resourceKinds: string[]
    inputSchema: Record<string, unknown>
    resultSchema: Record<string, unknown>
  }>
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
  scope?: 'all'
  /** Nonempty collection identity, at most 256 UTF-8 bytes; never read or action authority. */
  collectionKey?: string
  /** Complete plain-text configuration description, at most 4096 UTF-8 bytes. */
  configurationSummary?: string
  [key: string]: unknown
}

export interface ConnectionSource extends ConnectionResource {
  boundary?: { partition: string; sequence: number }
  enabledAfter: string
  policy: { automatic: boolean; askBeforeAct: boolean; immediate?: boolean }
}

export interface ConnectionResourceQuery {
  kind: string
  query: string
  cursor?: string
  scope?: 'all'
}

export interface ConnectionResourcePage {
  items: ConnectionResource[]
  hasMore?: boolean
  nextCursor?: string
  /** Dynamic discovery state, including an exact native account identity when blocked. */
  availability?: ConnectionAvailability
}

export interface ConnectionEvent {
  position?: { partition: string; sequence: number }
  id: string
  /** Stable within the provider account, independent of subscription scope. */
  objectId?: string
  /** Opaque equality token, paired with objectId; never a collection timestamp. */
  version?: string
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
  authTarget?: { pluginKey: string; connectorSlug: string; instance?: string }
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
    describe(dependency: string): Promise<{ pluginKey: string; connectorSlug: string }>
    callTool(
      dependency: string,
      input: { tool: string; arguments?: Record<string, string> }
    ): Promise<unknown>
  }
}

export type ConnectionCliDeclaration = (
  | { connectorSlug: string; toolId?: never }
  | { toolId: string; connectorSlug?: never }
) & {
  outputArgs: string[]
  operations: Record<
    string,
    {
      command: string[]
      parameters: Record<string, string>
      /** The host generates and validates the temporary output file; callers cannot choose it. */
      outputFile?: { flag: string }
    }
  >
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
  /** Only the authorized host invokes actions; declarations are not execution grants. */
  executeAction?(
    context: ConnectionContext,
    input: { action: string; source: ConnectionSource; [key: string]: unknown }
  ): Promise<unknown>
  readSource?(
    context: ConnectionContext,
    input: { source: ConnectionSource; query?: Record<string, unknown>; cursor?: string }
  ): Promise<{
    items: Array<{ id: string; [key: string]: unknown }>
    hasMore: boolean
    nextCursor?: string
    [key: string]: unknown
  }>
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
export declare function dependencySources(
  dependency: CodexConnectionDependency
): Array<CodexConnectionDependency['source']>
export declare function dependencyPlan(
  definition: ConnectionDefinition,
  inventory: InstalledConnectionDependency[],
  satisfies: (version: string, range: string) => boolean
): ConnectionDependencyResolution[]
export declare class ConnectionError extends Error {
  constructor(code: string, message: string, options?: { retryAfterMs?: number })
  code: string
  /** A bounded retry delay for collection reads only; never authorizes retrying actions. */
  retryAfterMs?: number
}
