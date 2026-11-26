import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, test, vi } from 'vitest'
import { beginWebConnectionCapture } from './web-connection-capture.js'

test('the recorder exposes structure while retaining the account identifier locally', async () => {
  let attached = false
  const debuggerSession = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    sendCommand: vi.fn(async (command: string) =>
      command === 'Network.getResponseBody'
        ? {
            body: JSON.stringify({
              user: { id: 42, name: 'Private Name', token: 'response-secret' },
              columns: ['id', 'duration'],
              results: [[123, 5000]],
            }),
          }
        : {}
    ),
  })
  const origin = 'https://analytics.example.test'
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerSession,
    isDestroyed: () => false,
    session: { cookies: { get: async () => [{ name: 'csrf', value: 'csrf-secret' }] } },
  })
  const recorder = await beginWebConnectionCapture(contents as unknown as WebContents, origin)
  function record(requestId: string, url: string) {
    debuggerSession.emit('message', {}, 'Network.requestWillBeSent', {
      requestId,
      type: 'Fetch',
      request: {
        method: 'POST',
        url,
        headers: { Cookie: 'session=credential', 'X-CSRFToken': 'csrf-secret' },
        postData: JSON.stringify({
          kind: 'Query',
          input: 'private search',
          password: 'body-secret',
        }),
      },
    })
    debuggerSession.emit('message', {}, 'Network.responseReceived', {
      requestId,
      response: { status: 200, mimeType: 'application/json' },
    })
    return () =>
      debuggerSession.emit('message', {}, 'Network.loadingFinished', {
        requestId,
        encodedDataLength: 250,
      })
  }
  record('cross-origin', 'https://other.example.test/query')()
  const finish = record('allowed', origin + '/query?date=2026-11-25&token=query-secret')
  const collected = recorder.collect()
  finish()
  const [item, extra] = await collected
  expect(extra).toBeUndefined()
  expect(item.sample).toEqual({
    method: 'POST',
    path: '/query',
    query: ['date'],
    body: { kind: 'Query', input: 'string' },
    response: {
      user: { id: 'number', name: 'string' },
      columns: ['id', 'duration'],
      results: [['number', 'number']],
    },
    accountPaths: [['user', 'id']],
  })
  expect(item.identity?.get('["user","id"]')).toBe(42)
  expect(item.csrf).toEqual({ header: 'x-csrftoken', cookie: 'csrf' })
  expect(debuggerSession.listenerCount('message')).toBe(0)
  expect(debuggerSession.detach).toHaveBeenCalledOnce()
})

test('closing a recording after the guest is destroyed never touches its debugger again', async () => {
  let destroyed = false
  const debuggerSession = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: vi.fn(async () => ({})),
  })
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed })
  Object.defineProperty(contents, 'debugger', {
    get() {
      if (destroyed) throw new Error('Object has been destroyed')
      return debuggerSession
    },
  })
  const recorder = await beginWebConnectionCapture(
    contents as unknown as WebContents,
    'https://analytics.example.test'
  )
  destroyed = true
  contents.emit('destroyed')
  expect(() => recorder.close()).not.toThrow()
})
