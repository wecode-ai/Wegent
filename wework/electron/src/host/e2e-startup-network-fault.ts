import { net, type Session } from 'electron'

/** Fail one real entry-module request through Chromium's protocol error API. */
export function installStartupNetworkFault(target: Session, origin: string): () => void {
  let active = true
  const dispose = () => {
    if (!active) return
    active = false
    target.protocol.uninterceptProtocol('http')
  }
  const installed = target.protocol.interceptBufferProtocol('http', (request, callback) => {
    const url = new URL(request.url)
    if (active && url.origin === origin && url.pathname.endsWith('.js')) {
      dispose()
      console.info('[startup-network-fault] injected')
      callback({ error: -21 })
      return
    }
    void net
      .fetch(request.url, {
        method: request.method,
        headers: request.headers,
        bypassCustomProtocolHandlers: true,
      })
      .then(async response =>
        callback({
          data: Buffer.from(await response.arrayBuffer()),
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
        })
      )
      .catch(() => callback({ error: -2 }))
  })
  if (!installed) throw new Error('Could not install the startup network fault')
  return dispose
}
