import {
  createCloudRuntimeIpcClient,
  type CloudRuntimeIpcClient,
} from '../vendor/chat-core/runtime-ipc.js'

interface Target {
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
}

/** Native cleanup uses the same authenticated transport as the conversation. */
export class McpAppRuntime {
  private readonly clients = new Map<
    string,
    { client: CloudRuntimeIpcClient; credential: { token: string } }
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
    const key = JSON.stringify(route)
    let entry = this.clients.get(key)
    const address = request.address as Record<string, unknown>
    if (typeof address?.deviceId !== 'string') throw new Error('Missing MCP App Runtime device')
    // Disposal belongs to the acquired client, even after the cloud settings are cleared.
    if (request.method === 'release' && entry)
      return entry.client.request('runtime.mcp_apps.request', request, address.deviceId)
    const connection = (await this.connection()) as
      | (Target & { token?: string; credentialMode?: string })
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
      entry = { credential, client }
      this.clients.set(key, entry)
    }
    entry.credential.token = token
    return entry.client.request('runtime.mcp_apps.request', request, address.deviceId)
  }

  dispose(): void {
    for (const { client } of this.clients.values()) client.dispose()
    this.clients.clear()
  }
}
