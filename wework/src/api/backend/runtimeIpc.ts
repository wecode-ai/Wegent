import { createCloudRuntimeIpcClient as createSharedCloudRuntimeIpcClient } from '@wegent/chat-core'

export { RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS } from '@wegent/chat-core'
export type { CloudRuntimeIpcClient } from '@wegent/chat-core'

export function createCloudRuntimeIpcClient(options: {
  socketBaseUrl: string
  socketPath: string
  token: string
}) {
  return createSharedCloudRuntimeIpcClient({
    socketBaseUrl: options.socketBaseUrl,
    socketPath: options.socketPath,
    getToken: () => options.token,
  })
}
