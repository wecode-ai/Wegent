import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge'

type Transport = Parameters<AppBridge['connect']>[0]

/** Bind both directions to one document's origin, including after navigation. */
export function appDocumentTransport(target: Window, origin: string): Transport {
  let listener: ((event: MessageEvent) => void) | undefined
  const transport: Transport = {
    async start() {
      listener = event => {
        if (event.source === target && event.origin === origin && event.data?.jsonrpc === '2.0') {
          transport.onmessage?.(event.data)
        }
      }
      window.addEventListener('message', listener)
    },
    async send(message) {
      target.postMessage(message, origin)
    },
    async close() {
      if (listener) window.removeEventListener('message', listener)
      transport.onclose?.()
    },
  }
  return transport
}
