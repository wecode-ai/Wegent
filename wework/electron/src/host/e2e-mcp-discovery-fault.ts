import type { Session } from 'electron'

/** Cancel real Chromium discovery requests without replacing any Runtime response. */
export class McpDiscoveryNetworkFault {
  private canceled = 0
  private active = false

  constructor(private readonly session: Pick<Session, 'webRequest'>) {}

  configure(enabled: boolean): { enabled: boolean; canceled: number } {
    if (enabled && !this.active) {
      this.canceled = 0
      this.session.webRequest.onBeforeRequest(
        { urls: ['http://127.0.0.1/wework/executor/v1/rpc'] },
        (details, callback) => {
          const bytes = details.uploadData?.map(item => item.bytes ?? Buffer.alloc(0)) ?? []
          let cancel = false
          try {
            const request = JSON.parse(Buffer.concat(bytes).toString('utf8'))
            cancel =
              request.method === 'runtime.mcp_apps.request' && request.params?.method === 'discover'
          } catch {
            // Other requests retain their normal Runtime handling.
          }
          if (cancel) this.canceled++
          callback({ cancel })
        }
      )
    } else if (!enabled && this.active) {
      this.session.webRequest.onBeforeRequest(null)
    }
    this.active = enabled
    return { enabled, canceled: this.canceled }
  }
}
