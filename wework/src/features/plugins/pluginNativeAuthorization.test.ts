import { afterEach, expect, test, vi } from 'vitest'
import { configurePluginNativeAuthorization } from './pluginNativeAuthorization'

afterEach(() => vi.unstubAllGlobals())

test('a legacy host without private credentials does not trigger provisioning retries', async () => {
  vi.stubGlobal('window', {
    weworkElectronPluginAuth: {
      configure: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'credentials_unavailable' },
      }),
    },
  })
  expect(await configurePluginNativeAuthorization('/api', 'token')).toEqual({
    ready: true,
    expiresIn: null,
  })
})

test('a host transport timeout remains retryable', async () => {
  vi.stubGlobal('window', {
    weworkElectronPluginAuth: {
      configure: vi.fn().mockRejectedValue(new Error('request timed out')),
    },
  })
  expect(await configurePluginNativeAuthorization('/api', 'token')).toEqual({
    ready: false,
    expiresIn: null,
  })
})

test('a released host without the bridge has no Native session to renew', async () => {
  vi.stubGlobal('window', {})
  expect(await configurePluginNativeAuthorization('/api', 'token')).toEqual({
    ready: true,
    expiresIn: null,
  })
})
