// @vitest-environment node

import { expect, test, vi } from 'vitest'
import {
  readExternalBrowserPage,
  requestExternalBrowser,
} from '../e2e/desktop/modules/external-browser-fixture.mjs'

test('external browser page evidence preserves the navigation URL of an HTTP error document', async () => {
  const url = 'http://127.0.0.3:1234/auth/wework/authorize?session_id=test-attempt'
  const request = vi.fn().mockResolvedValueOnce(url).mockResolvedValueOnce({
    url: 'chrome-error://chromewebdata/',
    title: '127.0.0.3',
    text: 'HTTP ERROR 404',
  })

  await expect(readExternalBrowserPage(request, 'fixture-session', () => 100)).resolves.toEqual({
    url,
    title: '127.0.0.3',
    text: 'HTTP ERROR 404',
  })
  expect(request).toHaveBeenNthCalledWith(1, '/session/fixture-session/url', undefined, 100)
  expect(request).toHaveBeenNthCalledWith(
    2,
    '/session/fixture-session/execute/sync',
    {
      script: 'return {title: document.title, text: document.body?.innerText ?? ""}',
      args: [],
    },
    100
  )
})

test('external browser requests retain the bounded timeout and native response checks', async () => {
  const value = { sessionId: 'fixture-session' }
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value }) })
  await expect(
    requestExternalBrowser('http://fixture', '/session', {}, 100, fetcher)
  ).resolves.toEqual(value)
  expect(fetcher).toHaveBeenCalledWith(
    'http://fixture/session',
    expect.objectContaining({
      method: 'POST',
      body: '{}',
      signal: expect.any(AbortSignal),
    })
  )
})

test('external browser failures identify the operation and retain the underlying cause', async () => {
  const cause = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const fetcher = vi.fn().mockRejectedValue(cause)
  await expect(
    requestExternalBrowser('http://fixture', '/session', {}, 100, fetcher)
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /ChromeDriver POST \/session failed after \d+ms \(budget 100ms\)/
    ),
    cause,
  })
})

test('external browser error context does not expose a session identifier', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('connection closed'))
  await expect(
    requestExternalBrowser('http://fixture', '/session/private-session/window', {}, 100, fetcher)
  ).rejects.toThrow('POST /session/:id/window')
})

test('external browser protocol errors still fail instead of becoming empty results', async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: false,
    json: async () => ({ value: { error: 'session not created' } }),
  })
  await expect(
    requestExternalBrowser('http://fixture', '/session', {}, 100, fetcher)
  ).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining('session not created') }),
  })
})
