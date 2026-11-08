// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import {
  PLUGIN_REMOTE_CATALOG_TIMEOUT_MS,
  withHeldComposerAppCatalog,
} from '../../e2e/desktop/modules/composer-network-isolation.mjs'
import { requestExecutor } from '../../e2e/desktop/modules/executor-rpc.mjs'

vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
afterEach(() => vi.resetAllMocks())

function fixture() {
  const read = Promise.withResolvers<unknown>()
  const proxy = {
    requests: ['CONNECT earlier.example:443'],
    release: vi.fn(() => read.resolve({})),
  }
  vi.mocked(requestExecutor).mockImplementation(async () => {
    proxy.requests.push('CONNECT chatgpt.com:443')
    return read.promise
  })
  return { read, proxy, control: { command: vi.fn() } }
}

test('starts a real app catalog read before verifying local inventory and releases it afterward', async () => {
  const { control, proxy } = fixture()
  await withHeldComposerAppCatalog(control, proxy, async (request: string) => {
    expect(request).toBe('CONNECT chatgpt.com:443')
    expect(proxy.release).not.toHaveBeenCalled()
    expect(requestExecutor).toHaveBeenCalledExactlyOnceWith(
      control,
      'codex.app_server_request',
      { method: 'app/list', params: { forceRefetch: true } },
      PLUGIN_REMOTE_CATALOG_TIMEOUT_MS
    )
  })
  expect(proxy.release).toHaveBeenCalledOnce()
})

test.each(['completed', 'failed'])(
  'rejects an app catalog that already %s before local verification',
  async state => {
    const { control, proxy } = fixture()
    if (state === 'completed') vi.mocked(requestExecutor).mockResolvedValue({})
    else vi.mocked(requestExecutor).mockRejectedValue(new Error('native read failed'))
    const verify = vi.fn()
    await expect(withHeldComposerAppCatalog(control, proxy, verify)).rejects.toThrow(
      'must remain pending'
    )
    expect(verify).not.toHaveBeenCalled()
    expect(proxy.release).toHaveBeenCalledOnce()
  }
)

test('rejects a remote read that settles while local inventory is being checked', async () => {
  const { control, proxy, read } = fixture()
  await expect(
    withHeldComposerAppCatalog(control, proxy, async () => {
      read.resolve({})
      await vi.waitFor(() => expect(requestExecutor).toHaveResolved())
    })
  ).rejects.toThrow('must remain pending')
  expect(proxy.release).toHaveBeenCalledOnce()
})

test('preserves local inventory assertion failures and releases the remote request', async () => {
  const { control, proxy } = fixture()
  const failure = new Error('installed plugin missing')
  await expect(
    withHeldComposerAppCatalog(control, proxy, async () => {
      throw failure
    })
  ).rejects.toBe(failure)
  expect(proxy.release).toHaveBeenCalledOnce()
})

test('observes the intentional proxy failure caused by releasing the held request', async () => {
  const { control, proxy, read } = fixture()
  proxy.release.mockImplementation(() => read.reject(new Error('proxy released with 502')))
  await expect(withHeldComposerAppCatalog(control, proxy, async () => {})).resolves.toBeUndefined()
  expect(proxy.release).toHaveBeenCalledOnce()
})
