import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeSessionConfig } from './backendConfig'
import {
  createWebIssueSession,
  parseWebSessionMessage,
  WebIssueSessionError,
} from './webIssueSession'

const redirect = '/collaboration/12/issues/ISSUE-1?commentId=comment-1&focusRequest=mobile-1'
const bootstrapUrl = `https://wegent.example/mobile-web-session?${new URLSearchParams({ redirect })}`
const nonce = 'a'.repeat(64)
const request = { type: 'wework.web-session.request' as const, nonce, redirect }
const config: RuntimeSessionConfig = {
  backendUrl: 'https://api.wegent.example',
  apiBaseUrl: 'https://api.wegent.example/api',
  socketBaseUrl: 'https://api.wegent.example',
  socketPath: '/socket.io',
  webUrl: 'https://wegent.example',
  accessToken: 'private-native-token',
}

afterEach(() => vi.unstubAllGlobals())

describe('WebView session bridge message validation', () => {
  it('validates Android origin-only events against the native main document URL', () => {
    expect(
      parseWebSessionMessage(
        JSON.stringify(request),
        'https://wegent.example',
        bootstrapUrl,
        bootstrapUrl
      )
    ).toEqual(request)
    expect(
      parseWebSessionMessage(
        JSON.stringify(request),
        'https://wegent.example',
        bootstrapUrl,
        'https://wegent.example/other'
      )
    ).toBeNull()
  })

  it('accepts only the exact bootstrap page and requested Issue including comment focus', () => {
    expect(parseWebSessionMessage(JSON.stringify(request), bootstrapUrl, bootstrapUrl)).toEqual(
      request
    )
    for (const source of [
      bootstrapUrl.replace('wegent.example', 'evil.example'),
      bootstrapUrl.replace('/mobile-web-session', '/other'),
      `${bootstrapUrl}#injected`,
      `${bootstrapUrl}&token=attacker`,
    ]) {
      expect(parseWebSessionMessage(JSON.stringify(request), source, bootstrapUrl)).toBeNull()
    }
    for (const invalid of [
      { ...request, nonce: 'weak' },
      { ...request, nonce: 'g'.repeat(64) },
      { ...request, redirect: '/collaboration/12/issues/OTHER' },
      { ...request, type: 'wework.web-session.grant', code: 'injected' },
    ]) {
      expect(parseWebSessionMessage(JSON.stringify(invalid), bootstrapUrl, bootstrapUrl)).toBeNull()
    }
    expect(parseWebSessionMessage('not-json', bootstrapUrl, bootstrapUrl)).toBeNull()
  })

  it('requires an error to include its challenge nonce', () => {
    const failure = { type: 'wework.web-session.error', nonce, status: 409 }
    expect(parseWebSessionMessage(JSON.stringify(failure), bootstrapUrl, bootstrapUrl)).toEqual(
      failure
    )
    expect(
      parseWebSessionMessage(
        JSON.stringify({ type: failure.type, status: 401 }),
        bootstrapUrl,
        bootstrapUrl
      )
    ).toBeNull()
  })
})

describe('native Web authorization', () => {
  it('authenticates only over the private API channel and delivers a nonce-bound one-time code', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ code: 'single-use-code', user_id: 6177, expires_at: Date.now() / 1000 + 60 })
    )
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const script = await createWebIssueSession(config, request, 6177, controller.signal)
    expect(fetcher).toHaveBeenCalledWith(`${config.apiBaseUrl}/auth/wework/web-sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer private-native-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ nonce, redirect }),
      signal: controller.signal,
    })
    const dispatchEvent = vi.fn()
    const runGrant = new Function('window', 'MessageEvent', script)
    runGrant(
      { dispatchEvent },
      class {
        constructor(
          readonly type: string,
          readonly init: { data: string }
        ) {}
      }
    )
    const event = dispatchEvent.mock.calls[0][0] as { type: string; init: { data: string } }
    expect(event.type).toBe('message')
    expect(JSON.parse(event.init.data)).toEqual({
      type: 'wework.web-session.grant',
      nonce,
      code: 'single-use-code',
    })
    expect(script).not.toContain(config.accessToken)
  })

  it.each([
    { user_id: 52, code: 'wrong-user', expires_at: Date.now() / 1000 + 60 },
    { user_id: 6177, code: 'expired', expires_at: 1 },
    { user_id: 6177, code: '', expires_at: Date.now() / 1000 + 60 },
  ])('rejects mismatched, expired or invalid grants: %j', async grant => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(grant))
    )
    await expect(
      createWebIssueSession(config, request, 6177, new AbortController().signal)
    ).rejects.toMatchObject({ name: 'WebIssueSessionError', status: 409 })
  })

  it.each([401, 403, 409])('preserves authorization failure %s for recovery UI', async status => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Authorization rejected' }, { status }))
    )
    await expect(
      createWebIssueSession(config, request, 6177, new AbortController().signal)
    ).rejects.toEqual(new WebIssueSessionError(status, 'Authorization rejected'))
  })
})
