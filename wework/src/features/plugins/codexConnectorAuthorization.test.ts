import { expect, test, vi } from 'vitest'
import {
  codexAppAuthorizationUrl,
  codexAuthorizationErrorKey,
  resolveCodexConnectorApp,
  readCodexAuthorizationApps,
  CODEX_AUTHORIZATION_CATALOG_TIMEOUT_MS,
  CodexAuthorizationTimeoutError,
} from './codexConnectorAuthorization'
import type { LocalDeviceApp } from '@/types/api'

test.each([
  [new Error('403 Forbidden <html><svg>private-response</svg></html>'), 'blocked'],
  [{ message: '401 Unauthorized <html>private-response</html>' }, 'account_required'],
  [new CodexAuthorizationTimeoutError(), 'timeout'],
  ['Request timeout <html>private-response</html>', 'timeout'],
  [new Error('<svg>private-response</svg>'), 'failed'],
  [null, 'failed'],
])('maps remote authorization errors to safe localized keys: %s', (error, suffix) => {
  expect(codexAuthorizationErrorKey(error)).toBe(`workbench.plugins_connector_auth_${suffix}`)
})

const app = (name: string, id = name): LocalDeviceApp => ({
  id,
  name,
  description: null,
  logoUrl: null,
  source: 'codex-app',
  isAccessible: false,
  installUrl: `https://auth.example.test/${name}`,
})

test.each(['Figma', 'Finances', 'Gmail'])('resolves %s instead of GitHub', name => {
  const selected = app(name)
  expect(
    resolveCodexConnectorApp(
      [app('GitHub'), selected],
      { slug: name.toLowerCase(), authPolicy: 'on_use' },
      []
    )
  ).toBe(selected)
})

test('prefers declared app identity over another account with the same name', () => {
  const selected = app('Gmail', 'connector_account_1')
  expect(
    resolveCodexConnectorApp(
      [app('Gmail', 'connector_account_2'), selected],
      { slug: 'gmail', authPolicy: 'on_use' },
      [{ name: 'Gmail', path: selected.id }]
    )
  ).toBe(selected)
})

test('refuses ambiguous accounts and unrelated applications', () => {
  const connector = { slug: 'gmail', authPolicy: 'on_use' as const }
  expect(resolveCodexConnectorApp([app('GitHub')], connector, [])).toBeNull()
  expect(resolveCodexConnectorApp([app('Gmail', '1'), app('Gmail', '2')], connector, [])).toBeNull()
})

test.each([
  'http://example.test/auth',
  'javascript:alert(1)',
  'https://user:password@example.test/auth',
  'not-a-url',
  null,
])('rejects unsafe or missing authorization URL: %s', installUrl => {
  expect(codexAppAuthorizationUrl({ ...app('Gmail'), installUrl })).toBeNull()
})

test('uses the live application URL without inventing provider parameters', () => {
  const selected = app('Figma')
  expect(codexAppAuthorizationUrl(selected)).toBe(selected.installUrl)
})

test('reuses app-server data for the URL and refreshes only for authorization verification', async () => {
  const list = vi.fn().mockResolvedValue([app('Gmail')])
  await readCodexAuthorizationApps(list)
  expect(list).toHaveBeenLastCalledWith({
    includeInaccessible: true,
    forceRefetch: false,
    signal: expect.any(AbortSignal),
  })
  await readCodexAuthorizationApps(list, true)
  expect(list).toHaveBeenLastCalledWith({
    includeInaccessible: true,
    forceRefetch: true,
    signal: expect.any(AbortSignal),
  })
})

test('times out the total authorization read and aborts late pagination', async () => {
  vi.useFakeTimers()
  try {
    let signal: AbortSignal | undefined
    const list = vi.fn().mockImplementation(params => {
      signal = params.signal
      return new Promise(() => undefined)
    })
    const pending = readCodexAuthorizationApps(list)
    const rejected = expect(pending).rejects.toBeInstanceOf(CodexAuthorizationTimeoutError)
    await vi.advanceTimersByTimeAsync(CODEX_AUTHORIZATION_CATALOG_TIMEOUT_MS)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
