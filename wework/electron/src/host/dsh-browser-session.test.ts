import { afterEach, expect, test, vi } from 'vitest'
import { installDshBrowserSession } from './dsh-browser-session.js'

afterEach(() => vi.useRealTimers())

test('installs exchanged cookies with native security and lifetime attributes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
  const set = vi.fn(async () => {})

  await installDshBrowserSession({ set }, 'http://127.0.0.1:54321/?token=fixture', [
    'session=signed%2Fvalue; Max-Age=3600; Expires=Mon, 12 Oct 2026 14:00:00 GMT; Path=/; HttpOnly; SameSite=Strict',
    'other=value; Domain=127.0.0.1; Path=/wework; Secure; SameSite=None; Expires=Mon, 12 Oct 2026 14:00:00 GMT',
  ])

  expect(set.mock.calls).toEqual([
    [
      expect.objectContaining({
        url: 'http://127.0.0.1:54321',
        name: 'session',
        value: 'signed%2Fvalue',
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        expirationDate: Date.now() / 1000 + 3600,
      }),
    ],
    [
      expect.objectContaining({
        name: 'other',
        domain: '127.0.0.1',
        path: '/wework',
        secure: true,
        sameSite: 'no_restriction',
        expirationDate: new Date('2026-10-12T14:00:00Z').getTime() / 1000,
      }),
    ],
  ])
})

test('rejects empty exchanges and invalid security attributes', async () => {
  const set = vi.fn(async () => {})
  await expect(installDshBrowserSession({ set }, 'http://127.0.0.1:54321', [])).rejects.toThrow(
    'authentication failed'
  )
  await expect(
    installDshBrowserSession({ set }, 'http://127.0.0.1:54321', ['session=value; SameSite=invalid'])
  ).rejects.toThrow('SameSite')
  expect(set).not.toHaveBeenCalled()
})

test('propagates native cookie storage failures instead of reporting readiness', async () => {
  const failure = new Error('Native cookie storage unavailable')
  const set = vi.fn(async () => {
    throw failure
  })
  await expect(
    installDshBrowserSession({ set }, 'http://127.0.0.1:54321', ['session=value'])
  ).rejects.toBe(failure)
})
