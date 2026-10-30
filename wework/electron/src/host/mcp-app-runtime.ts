import {
  createCloudRuntimeIpcClient,
  type CloudRuntimeIpcClient,
} from '../vendor/chat-core/runtime-ipc.js'

interface Target {
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
}

export async function readMcpAppConnection(storage: {
  read(): Promise<Record<string, string>>
}): Promise<unknown> {
  const raw = (await storage.read())['wework.cloudConnection']
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Stored cloud connection is invalid')
  }
}

/** Native cleanup uses the same authenticated transport as the conversation. */
export class McpAppRuntime {
  private readonly clients = new Map<
    string,
    {
      client: CloudRuntimeIpcClient
      credential: { token: string }
      target: string
      account: number | string | undefined
    }
  >()

  constructor(
    private readonly localRequest: (payload: Record<string, unknown>) => Promise<unknown>,
    private readonly refreshToken: (apiBaseUrl: string) => Promise<string>,
    private readonly connection: () => Promise<unknown>
  ) {}

  async request(payload: Record<string, unknown>): Promise<unknown> {
    const { target, ...request } = payload
    if (!target) return this.localRequest(request)
    if (typeof target !== 'object' || Array.isArray(target))
      throw new Error('Invalid MCP App Runtime target')
    const route = target as Target
    if (
      !['apiBaseUrl', 'socketBaseUrl', 'socketPath'].every(
        key => typeof (target as Record<string, unknown>)[key] === 'string'
      )
    )
      throw new Error('Invalid MCP App Runtime target')
    const key = request.sessionId
    if (typeof key !== 'string' || !key) throw new Error('Missing MCP App Runtime session')
    const targetKey = JSON.stringify(route)
    let entry = this.clients.get(key)
    if (entry && entry.target !== targetKey) throw new Error('MCP App Runtime target changed')
    const address = request.address as Record<string, unknown>
    if (typeof address?.deviceId !== 'string') throw new Error('Missing MCP App Runtime device')
    // Disposal belongs to the acquired client, even after the cloud settings are cleared.
    if (request.method === 'release' && entry)
      return this.release(key, entry.client, request, address.deviceId)
    const connection = (await this.connection()) as
      | (Target & { token?: string; credentialMode?: string; user?: { id?: number | string } })
      | null
    if (
      !connection ||
      !['apiBaseUrl', 'socketBaseUrl', 'socketPath'].every(
        key =>
          (connection as unknown as Record<string, unknown>)[key] ===
          (target as Record<string, unknown>)[key]
      )
    )
      throw new Error('MCP App Runtime target is not configured')
    const account = connection.user?.id
    if (entry && entry.account !== account) throw new Error('MCP App Runtime account changed')
    const token =
      connection.credentialMode !== 'desktop_refresh' && connection.token
        ? connection.token
        : await this.refreshToken(route.apiBaseUrl)
    if (!entry) {
      const credential = { token }
      const client = createCloudRuntimeIpcClient({
        socketBaseUrl: route.socketBaseUrl,
        socketPath: route.socketPath,
        getToken: () => credential.token,
      })
      entry = { credential, client, target: targetKey, account }
      this.clients.set(key, entry)
    }
    entry.credential.token = token
    if (request.method === 'release')
      return this.release(key, entry.client, request, address.deviceId)
    return entry.client.request('runtime.mcp_apps.request', request, address.deviceId)
  }

  private async release(
    key: string,
    client: CloudRuntimeIpcClient,
    request: Record<string, unknown>,
    deviceId: string
  ): Promise<unknown> {
    const result = await client.request('runtime.mcp_apps.request', request, deviceId)
    client.dispose()
    if (this.clients.get(key)?.client === client) this.clients.delete(key)
    return result
  }

  dispose(sessionId?: string): void {
    if (sessionId !== undefined) {
      this.clients.get(sessionId)?.client.dispose()
      this.clients.delete(sessionId)
      return
    }
    for (const { client } of this.clients.values()) client.dispose()
    this.clients.clear()
  }
}
