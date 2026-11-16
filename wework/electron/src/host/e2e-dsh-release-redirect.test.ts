import type { Session } from 'electron'
import { expect, test, vi } from 'vitest'
import { installE2eDshReleaseRedirect } from './e2e-dsh-release-redirect.js'

const source = 'https://github.com/wecode-ai/Wegent/releases/download/wework-updater/legacy.tar.gz'
const target = 'https://release-assets.githubusercontent.com/immutable-asset?signature=value'

test('redirects only the packaged DSH URL to the official release asset', () => {
  const register = vi.fn()
  installE2eDshReleaseRedirect(
    { onBeforeRequest: register } as unknown as Session['webRequest'],
    JSON.stringify({ source, target })
  )
  const [[filter, listener]] = register.mock.calls
  expect(filter).toEqual({ urls: [source] })
  const callback = vi.fn()
  listener({ url: source }, callback)
  listener({ url: source.replace('legacy', 'unrelated') }, callback)
  expect(callback.mock.calls).toEqual([[{ redirectURL: target }], [{}]])
})

test('rejects redirect destinations outside the official release asset host', () => {
  const register = vi.fn()
  expect(() =>
    installE2eDshReleaseRedirect(
      { onBeforeRequest: register } as unknown as Session['webRequest'],
      JSON.stringify({ source, target: 'https://example.invalid/file' })
    )
  ).toThrow('official GitHub release asset')
  expect(register).not.toHaveBeenCalled()
})
