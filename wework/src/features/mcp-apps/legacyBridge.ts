/** Adapt legacy window.openai widgets to the same audited MCP App host channel. */
function installLegacyBridge() {
  let sequence = 0
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error('App request timed out'))
      }, 30000)
      pending.set(id, {
        resolve: value => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
    })
  const globals: Record<string, unknown> = {
    toolInput: {},
    toolOutput: null,
    toolResponseMetadata: {},
    widgetState: null,
  }
  const publish = (patch: Record<string, unknown>) => {
    Object.assign(globals, patch)
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: patch } }))
  }
  Object.defineProperty(window, 'openai', {
    value: Object.assign(globals, {
      callTool: (name: string, args: unknown) =>
        request('tools/call', { name, arguments: args ?? {} }),
      sendFollowUpMessage: ({ prompt }: { prompt: string }) =>
        request('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] }),
      requestDisplayMode: (params: unknown) => request('ui/request-display-mode', params),
      openExternal: ({ href }: { href: string }) => request('ui/open-link', { url: href }),
      requestClose: () =>
        window.parent.postMessage(
          { jsonrpc: '2.0', method: 'ui/notifications/request-teardown', params: {} },
          '*'
        ),
      setWidgetState: (widgetState: unknown) => publish({ widgetState }),
      notifyIntrinsicHeight: (height: number) =>
        window.parent.postMessage(
          { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height } },
          '*'
        ),
    }),
    writable: false,
  })
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return
    const message = event.data
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    }
    if (message.method === 'ui/notifications/tool-input')
      publish({ toolInput: message.params.arguments })
    if (message.method === 'ui/notifications/tool-result')
      publish({
        toolOutput: message.params.structuredContent ?? null,
        toolResponseMetadata: message.params._meta ?? {},
      })
    if (message.method === 'ui/notifications/host-context-changed') publish(message.params)
    if (message.method === 'ui/resource-teardown')
      window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*')
  })
  void request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'legacy-widget', version: '1.0.0' },
    appCapabilities: {},
  }).then(value => {
    publish((value as { hostContext: Record<string, unknown> }).hostContext)
    window.parent.postMessage(
      { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} },
      '*'
    )
  })
}

export function legacyWidgetDocument(html: string): string {
  const script = `<script>(${installLegacyBridge.toString()})()</script>`
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}${script}`)
    : `${script}${html}`
}
