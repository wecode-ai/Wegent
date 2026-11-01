import { expect, test, vi } from 'vitest'
import { RendererStartupLoader } from './renderer-startup-loader.js'

const failure = {
  webContentsId: 7,
  url: 'http://127.0.0.1:5000/assets/entry.js',
  resourceType: 'script',
  error: 'net::ERR_NETWORK_CHANGED',
}

function options(load = vi.fn(async () => {})) {
  return { webContentsId: 7, url: 'http://127.0.0.1:5000/', load, onRecovery: vi.fn() }
}

test('reloads an interrupted entry module before reporting a successful load', async () => {
  const loader = new RendererStartupLoader()
  const load = vi.fn(async () => {
    if (load.mock.calls.length === 1) {
      loader.requestFailed(failure)
      loader.requestFailed(failure)
    }
  })
  const request = options(load)
  await loader.load(request)
  expect(load).toHaveBeenCalledTimes(2)
  expect(request.onRecovery).toHaveBeenCalledTimes(1)
})

test('fails repeated network changes and clears the active load', async () => {
  const loader = new RendererStartupLoader()
  const request = options(
    vi.fn(async () => {
      loader.requestFailed(failure)
    })
  )
  await expect(loader.load(request)).rejects.toThrow('repeated network changes')
  expect(request.load).toHaveBeenCalledTimes(2)
  expect(request.onRecovery).toHaveBeenCalledTimes(1)
  const next = options()
  await loader.load(next)
  expect(next.load).toHaveBeenCalledTimes(1)
})

test('recovers a main-frame network-change rejection through the same load', async () => {
  const loader = new RendererStartupLoader()
  const load = vi.fn(async () => {
    if (load.mock.calls.length !== 1) return
    loader.requestFailed({ ...failure, resourceType: 'mainFrame' })
    throw new Error('net::ERR_NETWORK_CHANGED')
  })
  await loader.load(options(load))
  expect(load).toHaveBeenCalledTimes(2)
})

test.each([
  { webContentsId: 8 },
  { url: 'http://127.0.0.1:6000/assets/entry.js' },
  { url: 'https://example.test/assets/entry.js' },
  { resourceType: 'xhr' },
  { error: 'net::ERR_CONNECTION_REFUSED' },
])('ignores failures outside the interrupted workbench entry: %j', async change => {
  const loader = new RendererStartupLoader()
  const request = options(
    vi.fn(async () => {
      loader.requestFailed({ ...failure, ...change })
    })
  )
  await loader.load(request)
  expect(request.load).toHaveBeenCalledTimes(1)
  expect(request.onRecovery).not.toHaveBeenCalled()
})

test('does not turn an unrelated load rejection into a successful load', async () => {
  const loader = new RendererStartupLoader()
  const error = new Error('net::ERR_CONNECTION_REFUSED')
  const request = options(
    vi.fn(async () => {
      throw error
    })
  )
  await expect(loader.load(request)).rejects.toBe(error)
  expect(request.load).toHaveBeenCalledTimes(1)
  expect(request.onRecovery).not.toHaveBeenCalled()
})
