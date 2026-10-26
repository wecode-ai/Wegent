import { describe, expect, test, vi } from 'vitest'
import { requestE2ERuntime } from './e2e-runtime-request.js'

const environment = { VITE_WEWORK_E2E: 'true', WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:5555' }
const url = 'http://127.0.0.1:3000/wework/executor/v1/rpc'

describe('authenticated E2E Runtime requests', () => {
  test.each([{}, { VITE_WEWORK_E2E: 'true' }, { WEWORK_E2E_CONTROL_URL: 'http://localhost' }])(
    'requires both isolated verification settings: %j',
    async settings => {
      const cookies = vi.fn()
      await expect(requestE2ERuntime(settings, { url }, cookies)).rejects.toThrow('isolated E2E')
      expect(cookies).not.toHaveBeenCalled()
    }
  )
  test.each([
    'https://127.0.0.1:3000/wework/api',
    'http://evil.test/wework/api',
    'http://127.0.0.1:3000/other',
    'http://user@127.0.0.1:3000/wework/api',
  ])('rejects targets outside the local Runtime: %s', async target => {
    const cookies = vi.fn()
    await expect(requestE2ERuntime(environment, { url: target }, cookies)).rejects.toThrow(
      'local Wework'
    )
    expect(cookies).not.toHaveBeenCalled()
  })
  test('fails without an authenticated browser session', async () => {
    const request = vi.fn()
    await expect(requestE2ERuntime(environment, { url }, async () => [], request)).rejects.toThrow(
      'authentication is unavailable'
    )
    expect(request).not.toHaveBeenCalled()
  })
  test('uses only the target authority cookie, preserves errors, and refuses redirects', async () => {
    const cookies = vi.fn(async () => [{ name: 'dsh-auth-test', value: 'signed-session' }])
    const request = vi.fn<typeof fetch>(async () => new Response('{"ok":false}', { status: 403 }))
    const result = await requestE2ERuntime(
      environment,
      {
        url,
        method: 'POST',
        headers: { cookie: 'forged=1' },
        body: '{}',
      },
      cookies,
      request
    )
    expect(cookies).toHaveBeenCalledWith('http://127.0.0.1:3000')
    expect(request).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    )
    expect(new Headers(request.mock.calls[0][1]?.headers).get('cookie')).toBe(
      'dsh-auth-test=signed-session'
    )
    expect(result.status).toBe(403)
    expect(result.body).toBe('{"ok":false}')
  })
})
