import {
  createCloudRuntimeIpcClient,
  type CloudRuntimeIpcClient,
} from '../vendor/chat-core/runtime-ipc.js'
import {
  configuredCloudRuntimeCredentials,
  configuredCloudRuntimeTarget,
  type CloudRuntimeTarget,
} from './cloud-connection-profile.js'
import type { ModelRuntimeTransport } from './model-runtime-request.js'

interface RuntimeCredentials {
  token: string | null
}

interface RuntimeSocket {
  client: CloudRuntimeIpcClient
  pending: number
}

/** One active connection per account/profile; the Backend retains all runtime authorization. */
export class CloudModelRuntime {
  private current: {
    identity: string
    credentials: RuntimeCredentials
    active: RuntimeSocket
    draining: Set<RuntimeSocket>
  } | null = null

  constructor(
    private readonly connection: () => Promise<unknown>,
    private readonly refreshToken: (apiBaseUrl: string, expectedUserId: number) => Promise<string>
  ) {}

  async transport(input: Record<string, unknown>): Promise<ModelRuntimeTransport> {
    const connection = await this.connection()
    const { account } = configuredCloudRuntimeTarget(input.target, connection)
    if (account !== input.expectedUserId) throw new Error('Cloud model request account changed')
    if (typeof input.deviceId !== 'string' || !input.deviceId.trim())
      throw new Error('Cloud model request device is required')
    const { target, token } = await configuredCloudRuntimeCredentials(
      input.target,
      connection,
      this.refreshToken
    )
    const identity = JSON.stringify([target, account])
    if (this.current?.identity !== identity) {
      this.dispose()
      const credentials = { token }
      this.current = {
        identity,
        credentials,
        active: this.createSocket(target, credentials),
        draining: new Set(),
      }
    }
    const current = this.current
    if (current.credentials.token !== token) {
      const previous = current.active
      current.active = this.createSocket(target, current.credentials)
      current.credentials.token = token
      if (previous.pending) current.draining.add(previous)
      else previous.client.dispose()
    }
    return {
      request: async (method, params, deviceId) => {
        const configured = configuredCloudRuntimeTarget(input.target, await this.connection())
        if (configured.account !== input.expectedUserId || this.current !== current)
          throw new Error('Cloud model request account changed')
        const socket = current.active
        socket.pending += 1
        try {
          return await socket.client.request(
            method,
            params,
            deviceId,
            typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined
          )
        } finally {
          socket.pending -= 1
          if (!socket.pending && current.draining.delete(socket)) socket.client.dispose()
        }
      },
      dispose: () => this.dispose(),
    }
  }

  dispose(): void {
    const current = this.current
    this.current = null
    if (!current) return
    current.credentials.token = null
    current.active.client.dispose()
    for (const socket of current.draining) socket.client.dispose()
    current.draining.clear()
  }

  private createSocket(target: CloudRuntimeTarget, credentials: RuntimeCredentials): RuntimeSocket {
    return {
      pending: 0,
      client: createCloudRuntimeIpcClient({
        socketBaseUrl: target.socketBaseUrl,
        socketPath: target.socketPath,
        getToken: () => credentials.token,
      }),
    }
  }
}
