import { describe, expect, it, vi } from 'vitest'
import { appDocumentTransport } from './transport'

describe('MCP App transport authority', () => {
  it('accepts only the exact source and document origin, and removes listeners on close', async () => {
    const target = document.createElement('iframe')
    document.body.append(target)
    const source = target.contentWindow!
    const origin = 'http://127.0.0.1:9000'
    const transport = appDocumentTransport(source, origin)
    transport.onmessage = vi.fn()
    await transport.start()
    const data = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'read' }, id: 1 }
    const send = (from: MessageEventSource, at: string) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: from, origin: at }))
    send(window, origin)
    send(source, 'https://other.example')
    expect(transport.onmessage).not.toHaveBeenCalled()
    send(source, origin)
    expect(transport.onmessage).toHaveBeenCalledOnce()
    await transport.close()
    send(source, origin)
    expect(transport.onmessage).toHaveBeenCalledOnce()
    target.remove()
  })
})
