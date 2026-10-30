/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'

const source = readFileSync(resolve(process.cwd(), 'src/app/mobile-web-session/route.ts'), 'utf8')
const html = source.match(/const HTML = String.raw`([\s\S]*?)`\n/)![1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]

function browser(fragment: string, tokens: Record<string, string> = {}) {
  const values = new Map(Object.entries(tokens))
  const storage = {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => values.set(key, value)),
    removeItem: jest.fn((key: string) => values.delete(key)),
  }
  const status = { textContent: '' }
  const document = { cookie: '', getElementById: () => status }
  const location = {
    hash: fragment,
    search: '?redirect=%2Fcollaboration%2F123%2Fissues%2FISSUE-1',
    protocol: 'https:',
    replace: jest.fn(),
  }
  const listeners: Record<string, (event: { data: string }) => Promise<void>> = {}
  const window = {
    location,
    localStorage: storage,
    crypto: webcrypto,
    history: { replaceState: jest.fn() },
    addEventListener: jest.fn(
      (name: string, handler: (event: { data: string }) => Promise<void>) => {
        listeners[name] = handler
      }
    ),
    ReactNativeWebView: undefined as undefined | { postMessage: jest.Mock },
  }
  const fetch = jest.fn()
  const run = () =>
    runInNewContext(script, { window, document, URLSearchParams, URL, Uint8Array, atob, fetch })
  return { window, document, storage, location, status, listeners, fetch, run }
}

describe('mobile Web authorization handoff', () => {
  it('never replaces an existing account from a URL fragment token', async () => {
    const page = browser(
      '#token=attacker-session&redirect=%2Fcollaboration%2F123%2Fissues%2FISSUE-1',
      {
        auth_token: 'victim-session',
        auth_token_expire: '1999999999999',
      }
    )
    await page.run()
    expect(page.storage.getItem('auth_token')).toBe('victim-session')
    expect(page.storage.setItem).not.toHaveBeenCalled()
    expect(page.location.replace).not.toHaveBeenCalled()
    expect(page.fetch).not.toHaveBeenCalled()
  })

  it('does not establish a new login from an attacker URL', async () => {
    const page = browser(
      '#token=attacker-session&redirect=%2Fcollaboration%2F123%2Fissues%2FISSUE-1'
    )
    await page.run()
    expect(page.storage.setItem).not.toHaveBeenCalled()
    expect(page.document.cookie).toBe('')
    expect(page.location.replace).not.toHaveBeenCalled()
  })

  it('only accepts the native grant for this page challenge and consumes it once', async () => {
    const page = browser('')
    const postMessage = jest.fn()
    page.window.ReactNativeWebView = { postMessage }
    page.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'server-session', expires_at: 1999999999 }),
    })
    await page.run()
    const request = JSON.parse(postMessage.mock.calls[0][0])
    expect(request).toEqual({
      type: 'wework.web-session.request',
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
      redirect: '/collaboration/123/issues/ISSUE-1',
    })
    const grant = { type: 'wework.web-session.grant', nonce: request.nonce, code: 'code' }
    await page.listeners.message({ data: JSON.stringify({ ...grant, nonce: 'wrong-page' }) })
    expect(page.fetch).not.toHaveBeenCalled()
    await page.listeners.message({ data: JSON.stringify(grant) })
    await page.listeners.message({ data: JSON.stringify(grant) })
    expect(page.fetch).toHaveBeenCalledTimes(1)
    expect(page.storage.getItem('auth_token')).toBe('server-session')
    expect(page.document.cookie).toContain('; Secure;')
    expect(page.location.replace).toHaveBeenCalledWith('/collaboration/123/issues/ISSUE-1')
  })

  it('passes both existing account tokens and preserves them on an identity conflict', async () => {
    const page = browser('', { auth_token: 'local-account' })
    page.document.cookie = 'auth_token=cookie-account'
    const postMessage = jest.fn()
    page.window.ReactNativeWebView = { postMessage }
    page.fetch.mockResolvedValue({ ok: false, status: 409 })
    await page.run()
    const { nonce } = JSON.parse(postMessage.mock.calls[0][0])
    await page.listeners.message({
      data: JSON.stringify({ type: 'wework.web-session.grant', nonce, code: 'code' }),
    })
    expect(JSON.parse(page.fetch.mock.calls[0][1].body).existing_tokens).toEqual([
      'local-account',
      'cookie-account',
    ])
    expect(page.storage.getItem('auth_token')).toBe('local-account')
    expect(page.document.cookie).toBe('auth_token=cookie-account')
    expect(page.storage.setItem).not.toHaveBeenCalled()
    expect(page.location.replace).not.toHaveBeenCalled()
    expect(JSON.parse(postMessage.mock.calls[1][0])).toEqual({
      type: 'wework.web-session.error',
      status: 409,
      nonce,
    })
  })

  it('preserves an account change that happens while exchange is pending', async () => {
    const page = browser('', { auth_token: 'original-account' })
    const postMessage = jest.fn()
    page.window.ReactNativeWebView = { postMessage }
    let complete!: (value: unknown) => void
    page.fetch.mockReturnValue(
      new Promise(resolve => {
        complete = resolve
      })
    )
    await page.run()
    const { nonce } = JSON.parse(postMessage.mock.calls[0][0])
    const pending = page.listeners.message({
      data: JSON.stringify({ type: 'wework.web-session.grant', nonce, code: 'code' }),
    })
    page.storage.setItem('auth_token', 'new-account')
    page.storage.setItem.mockClear()
    complete({
      ok: true,
      json: async () => ({ access_token: 'old-account', expires_at: 1999999999 }),
    })
    await pending
    expect(page.storage.getItem('auth_token')).toBe('new-account')
    expect(page.storage.setItem).not.toHaveBeenCalled()
    expect(page.location.replace).not.toHaveBeenCalled()
  })

  it('keeps the focused comment and focus request in the bound destination', async () => {
    const page = browser('')
    const redirect = '/collaboration/123/issues/ISSUE-1?commentId=comment-17&focusRequest=open-2'
    page.location.search = '?' + new URLSearchParams({ redirect })
    const postMessage = jest.fn()
    page.window.ReactNativeWebView = { postMessage }
    await page.run()
    expect(JSON.parse(postMessage.mock.calls[0][0]).redirect).toBe(redirect)
  })
})
