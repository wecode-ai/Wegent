import { expect, it, vi } from 'vitest'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import { saveLocalCodexTransport } from './localCodexSettings'

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

it('rebuilds the transport edit from the latest provider after a version conflict', async () => {
  const request = vi.mocked(requestLocalExecutor)
  request
    .mockResolvedValueOnce({ layers: [{ name: { type: 'user' }, version: 'old', config: {} }] })
    .mockRejectedValueOnce(
      new Error('Configuration was modified since last read. Fetch latest version and retry.')
    )
    .mockResolvedValueOnce({
      layers: [
        {
          name: { type: 'user' },
          version: 'new',
          config: { model_providers: { '~': { name: 'Existing provider' } } },
        },
      ],
    })
    .mockResolvedValueOnce({})

  await saveLocalCodexTransport('websocket')

  expect(request).toHaveBeenCalledTimes(4)
  expect(request).toHaveBeenLastCalledWith('codex.app_server_request', {
    method: 'config/value/write',
    params: {
      keyPath: 'model_providers."~"',
      value: { supports_websockets: true },
      mergeStrategy: 'upsert',
      expectedVersion: 'new',
    },
  })
})
