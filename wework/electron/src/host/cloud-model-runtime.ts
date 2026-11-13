import {
  createCloudRuntimeIpcClient,
  type CloudRuntimeIpcClient,
} from '../vendor/chat-core/runtime-ipc.js'
import {
  configuredCloudRuntimeCredentials,
  configuredCloudRuntimeTarget,
} from './cloud-connection-profile.js'
import type { ModelRuntimeTransport } from './model-runtime-request.js'

/** One native connection per current account/profile; the Backend retains all runtime authorization. */
export class CloudModelRuntime {
  private current: {
    identity: string
    credential: { token: string }
    client: CloudRuntimeIpcClient
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
      const credential = { token }
      const client = createCloudRuntimeIpcClient({
        socketBaseUrl: target.socketBaseUrl,
        socketPath: target.socketPath,
        getToken: () => credential.token,
      })
      this.current = { identity, credential, client }
    }
    const current = this.current!
    current.credential.token = token
    return {
      request: async (method, params, deviceId) => {
        const configured = configuredCloudRuntimeTarget(input.target, await this.connection())
        if (configured.account !== input.expectedUserId || this.current !== current)
          throw new Error('Cloud model request account changed')
        return current.client.request(
          method,
          params,
          deviceId,
          typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined
        )
      },
      dispose: () => this.dispose(),
    }
  }

  dispose(): void {
    this.current?.client.dispose()
    this.current = null
  }
}
