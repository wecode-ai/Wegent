import { describe, expect, test, vi } from 'vitest'
import type { CloudCredentialService } from './cloud-credential-service.js'
import { PluginNativeAuthorization } from './plugin-native-authorization.js'

const session = {
  backend_url: 'https://backend',
  account_token: 'access-secret',
  native_token: 'native-secret',
  expires_at: Math.floor(Date.now() / 1000) + 600,
}
const deferred = () => {
  let resolve!: (value: typeof session | null) => void
  const promise = new Promise<typeof session | null>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(pluginNativeSession = vi.fn().mockResolvedValue(session)) {
  const request = vi.fn().mockResolvedValue({ enabled: true })
  const credentials = () => ({ pluginNativeSession }) as unknown as CloudCredentialService
  return {
    authorization: new PluginNativeAuthorization(credentials, request),
    request,
    pluginNativeSession,
  }
}
describe('Native plugin authorization', () => {
  test('sends secrets only to Native and returns metadata', async () => {
    const { authorization, request } = fixture()
    const result = await authorization.configure('https://backend/api', 'access-secret')
    expect(request).toHaveBeenCalledWith('executor.plugin_auth.configure', {
      configuration_revision: 1,
      session,
    })
    expect(result.enabled).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  test('a delayed provision cannot resurrect a cleared account', async () => {
    const pending = deferred()
    const { authorization, request } = fixture(vi.fn().mockReturnValue(pending.promise))
    const configuring = authorization.configure('https://backend/api', 'access-secret')
    await authorization.clear()
    pending.resolve(session)
    await configuring
    expect(request.mock.calls).toEqual([
      ['executor.plugin_auth.configure', { configuration_revision: 2, session: null }],
    ])
  })
  test('later account provisioning wins even when replies arrive out of order', async () => {
    const pending = deferred()
    const { authorization, request } = fixture(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(null)
    )
    const first = authorization.configure('https://old/api', 'old-token')
    const second = await authorization.configure('https://new/api', 'new-token')
    pending.resolve(session)
    await first
    expect(second).toEqual({ enabled: false, expiresIn: null })
    expect(request).toHaveBeenCalledExactlyOnceWith('executor.plugin_auth.configure', {
      configuration_revision: 2,
      session: null,
    })
  })
})

test('logout propagates Native revocation failure and only tolerates a released unsupported method', async () => {
  const { authorization, request } = fixture()
  request.mockRejectedValueOnce(new Error('Native session clear timed out'))
  await expect(authorization.clear()).rejects.toThrow('Native session clear timed out')
  request.mockRejectedValueOnce(
    new Error('Unsupported app IPC method: executor.plugin_auth.configure')
  )
  await expect(authorization.clear()).resolves.toBeUndefined()
})
