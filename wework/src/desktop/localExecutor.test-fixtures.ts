import { vi } from 'vitest'
import { describeDshExecutor, requestDshExecutor } from '@/api/dsh/executorTransport'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export const marketplace = {
  id: 'wework-personal',
  path: '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal',
  pluginCount: 1,
  defaultPluginNames: ['smart-app-builder'],
  contentHash: 'abc123',
}

export function mockStartup(): void {
  vi.mocked(describeDshExecutor).mockResolvedValue({
    protocol_version: 1,
    device_id: 'electron-device',
    runtime_instance_id: 'electron-runtime',
    version: '1.8.6',
    capabilities: ['executor.plugins'],
    renderer_methods: ['runtime.*'],
    transports: ['local-endpoint-ndjson'],
  })
  vi.mocked(requestDshExecutor).mockImplementation(async method => {
    if (method === 'runtime.codex.ensure_started') {
      return { ready: true, started: true, initializeElapsedMs: 37 }
    }
    if (method === 'executor.plugins.initialize_bundled_marketplace') return marketplace
    if (method === 'runtime.codex.plugin.reconcile_bundled_marketplace')
      return { marketplaceName: marketplace.id, action: 'unchanged' }
    if (method === 'runtime.codex.plugin.sync_bundled') return { status: 'ready', updated: false }
    return {}
  })
}
