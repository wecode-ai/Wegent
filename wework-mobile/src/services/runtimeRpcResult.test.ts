import { base64 } from '@scure/base'
import { gzipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { unwrapLocalRuntimeResponse } from './runtimeRpcResult'

describe('canonical native IPC responses', () => {
  it('decodes compressed results for every local caller', async () => {
    const result = { turns: [{ id: 'turn', content: '完整内容' }] }
    await expect(
      unwrapLocalRuntimeResponse({
        type: 'response',
        ok: true,
        id: 'native-1',
        result: {
          __runtimeRpcEncoding: 'gzip+base64+json',
          payload: base64.encode(gzipSync(strToU8(JSON.stringify(result)))),
        },
      })
    ).resolves.toEqual(result)
  })
  it('retains executor error code, retry and provider metadata', async () => {
    await expect(
      unwrapLocalRuntimeResponse({
        type: 'response',
        ok: false,
        id: 'native-1',
        error: {
          message: 'busy',
          code: 'runtime_read_busy',
          retryAfterMs: 200,
          providerCode: 'locked',
          retryable: true,
        },
      })
    ).rejects.toMatchObject({
      message: 'busy',
      code: 'runtime_read_busy',
      retryAfterMs: 200,
      providerCode: 'locked',
      retryable: true,
    })
  })
  it('rejects an unframed result instead of hiding a native protocol mismatch', async () => {
    await expect(unwrapLocalRuntimeResponse({ accepted: true })).rejects.toThrow('IPC')
  })
})
