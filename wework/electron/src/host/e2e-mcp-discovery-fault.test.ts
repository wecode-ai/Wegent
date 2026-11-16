import type { Session } from 'electron'
import { expect, test, vi } from 'vitest'
import { McpDiscoveryNetworkFault } from './e2e-mcp-discovery-fault.js'

test('cancels only app discovery and restores real networking on cleanup', () => {
  const register = vi.fn()
  const fault = new McpDiscoveryNetworkFault({
    webRequest: { onBeforeRequest: register } as unknown as Session['webRequest'],
  })
  expect(fault.configure(true)).toEqual({ enabled: true, canceled: 0 })
  const listener = register.mock.calls[0][1]
  for (const [body, cancel] of [
    [JSON.stringify({ method: 'runtime.mcp_apps.request', params: { method: 'discover' } }), true],
    [
      JSON.stringify({ method: 'runtime.mcp_apps.request', params: { method: 'initialize' } }),
      false,
    ],
    [JSON.stringify({ method: 'runtime.tasks.transcript', params: {} }), false],
    ['not-json', false],
  ] as const) {
    const callback = vi.fn()
    listener({ uploadData: [{ bytes: Buffer.from(body) }] }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel })
  }
  expect(fault.configure(true)).toEqual({ enabled: true, canceled: 1 })
  expect(register).toHaveBeenCalledTimes(1)
  expect(fault.configure(false)).toEqual({ enabled: false, canceled: 1 })
  expect(register).toHaveBeenLastCalledWith(null)
})
