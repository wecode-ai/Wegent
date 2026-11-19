// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import { verifyNativeRpcErrorCollection } from '../e2e/desktop/modules/error-collection.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'

vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))

const marker = 'WEWORK_E2E_NATIVE_RPC_ERROR'
const nativeLine =
  `codex JSON-RPC request failed method=config/read request_id=5 ` +
  `rpc_error={"code":-32600,"message":"invalid type: string ${marker}, expected a boolean"}\n`

afterEach(() => vi.mocked(requestExecutor).mockReset())

function fixture(chunks, { level = 'error', type = 'stderr' } = {}) {
  vi.mocked(requestExecutor).mockRejectedValue(new Error(`Native rejection: ${marker}`))
  const records = chunks.map(message => ({
    instanceId: 'collector-one',
    source: 'runtime',
    type,
    level,
    details: { message, childPid: 123 },
  }))
  return {
    records,
    errors: {
      mark: () => 7,
      query: options => {
        expect(options.after).toBe(7)
        return records.filter(
          event =>
            event.source === options.source &&
            event.type === options.type &&
            event.level === options.level
        )
      },
      waitForRecord: async (match, options) => {
        expect(options).toEqual({ after: 7, timeoutMs: 10000 })
        if (!match()) throw new Error('Native error probe missing')
      },
      assertCollectedErrors: vi.fn(),
    },
  }
}

test('collects split native stderr without certifying adjacent unknown errors', async () => {
  const control = fixture(['unrelated failure\n', ...nativeLine.split('')])
  await verifyNativeRpcErrorCollection(control, 10000)
  expect(requestExecutor).toHaveBeenCalledWith(
    control,
    'runtime.codex.app_server.request',
    { method: 'config/read', params: { includeLayers: marker } },
    10000
  )
  expect(control.errors.assertCollectedErrors).not.toHaveBeenCalled()
})

test.each([
  { level: 'info', type: 'stdout' },
  { level: 'info', type: 'stderr' },
  { level: 'error', type: 'stdout' },
])('rejects native failures on the wrong stream or severity: %j', async options => {
  await expect(
    verifyNativeRpcErrorCollection(fixture([nativeLine], options), 10000)
  ).rejects.toThrow('Native error probe missing')
})

test.each([
  nativeLine.replace('-32600', '-32603'),
  nativeLine.replace(marker, 'ANOTHER_OPERATION'),
  nativeLine.replace('method=config/read', 'method=app/list'),
  nativeLine.trimEnd(),
])('rejects unrelated or incomplete native error evidence: %s', async line => {
  await expect(verifyNativeRpcErrorCollection(fixture([line]), 10000)).rejects.toThrow(
    'Native error probe missing'
  )
})

test('cannot accept a successful native request as fault injection', async () => {
  const control = fixture([nativeLine])
  vi.mocked(requestExecutor).mockResolvedValue({})
  await expect(verifyNativeRpcErrorCollection(control, 10000)).rejects.toThrow(
    'Missing expected rejection'
  )
})

test.each(['process', 'collector'])(
  'cannot splice a native error across %s boundaries',
  async boundary => {
    const split = nativeLine.indexOf(marker)
    const control = fixture([nativeLine.slice(0, split), nativeLine.slice(split)])
    if (boundary === 'process') control.records[1].details.childPid = 456
    else control.records[1].instanceId = 'collector-two'
    await expect(verifyNativeRpcErrorCollection(control, 10000)).rejects.toThrow(
      'Native error probe missing'
    )
  }
)
