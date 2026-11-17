import type { Session } from 'electron'
import { afterEach, expect, test, vi } from 'vitest'
import { e2eErrorLog } from './e2e-error-log.js'
import { installE2ENetworkErrors, recordE2ENetworkError } from './e2e-network-errors.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('observes connection failures and HTTP failures without collecting query credentials', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record')
  const webRequest = {
    onErrorOccurred: vi.fn(),
    onCompleted: vi.fn(),
    onSendHeaders: vi.fn(),
    onResponseStarted: vi.fn(),
  }
  installE2ENetworkErrors({ webRequest } as unknown as Session)
  const details = {
    url: 'https://synthetic-user:synthetic-password@upstream.test:9443/route?token=synthetic-secret',
    id: 42,
    resourceType: 'xhr',
    method: 'POST',
    webContentsId: 1,
  }
  webRequest.onErrorOccurred.mock.calls[0][1]({ ...details, error: 'net::ERR_CONNECTION_RESET' })
  webRequest.onCompleted.mock.calls[0][1]({ ...details, statusCode: 503 })
  webRequest.onCompleted.mock.calls[0][1]({ ...details, statusCode: 200 })
  expect(record).toHaveBeenCalledTimes(3)
  expect(record.mock.calls.map(call => call[1])).toEqual([
    'started',
    'request-failed',
    'http-failed',
  ])
  expect(JSON.stringify(record.mock.calls)).not.toContain('synthetic-secret')
  expect(JSON.stringify(record.mock.calls)).not.toContain('synthetic-password')
  expect(record.mock.calls[2][3]).toMatchObject({
    origin: 'https://upstream.test:9443',
    path: '/route',
    requestId: 42,
    resourceType: 'xhr',
  })
})

test('does not register network interceptors in ordinary sessions', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  const webRequest = {
    onErrorOccurred: vi.fn(),
    onCompleted: vi.fn(),
    onSendHeaders: vi.fn(),
    onResponseStarted: vi.fn(),
  }
  installE2ENetworkErrors({ webRequest } as unknown as Session)
  expect(webRequest.onErrorOccurred).not.toHaveBeenCalled()
  expect(webRequest.onCompleted).not.toHaveBeenCalled()
  expect(webRequest.onSendHeaders).not.toHaveBeenCalled()
  expect(webRequest.onResponseStarted).not.toHaveBeenCalled()
})

function timingSession() {
  const webRequest = {
    onErrorOccurred: vi.fn(),
    onCompleted: vi.fn(),
    onSendHeaders: vi.fn(),
    onResponseStarted: vi.fn(),
  }
  const target = { webRequest } as unknown as Session
  installE2ENetworkErrors(target)
  return { webRequest, target }
}

const requestDetails = {
  id: 42,
  url: 'https://upstream.test/route?token=synthetic-secret',
  resourceType: 'xhr',
  method: 'POST',
  webContentsId: 1,
}

test('retains send-to-response and send-to-failure timing through the shared host error hook', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record')
  const clock = vi.spyOn(performance, 'now')
  const { webRequest, target } = timingSession()
  clock.mockReturnValue(10)
  webRequest.onSendHeaders.mock.calls[0][1](requestDetails)
  clock.mockReturnValue(30)
  webRequest.onResponseStarted.mock.calls[0][1](requestDetails)
  clock.mockReturnValue(226)
  recordE2ENetworkError(
    { ...requestDetails, error: 'net::ERR_ABORTED' } as Electron.OnErrorOccurredListenerDetails,
    target
  )
  expect(record.mock.calls.at(-1)?.[3]).toMatchObject({
    sinceSendHeadersMs: 216,
    responseHeadersAfterSendMs: 20,
  })
  expect(JSON.stringify(record.mock.calls)).not.toContain('synthetic-secret')
})

test('missing response headers and a successfully completed request cannot manufacture zero latency', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record')
  const clock = vi.spyOn(performance, 'now')
  const { webRequest } = timingSession()
  clock.mockReturnValue(10)
  webRequest.onSendHeaders.mock.calls[0][1](requestDetails)
  clock.mockReturnValue(210)
  webRequest.onErrorOccurred.mock.calls[0][1]({ ...requestDetails, error: 'net::ERR_ABORTED' })
  expect(record.mock.calls.at(-1)?.[3]).toMatchObject({
    sinceSendHeadersMs: 200,
    responseHeadersAfterSendMs: null,
  })
  webRequest.onSendHeaders.mock.calls[0][1](requestDetails)
  webRequest.onCompleted.mock.calls[0][1]({ ...requestDetails, statusCode: 200 })
  webRequest.onErrorOccurred.mock.calls[0][1]({ ...requestDetails, error: 'net::ERR_FAILED' })
  expect(record.mock.calls.at(-1)?.[3]).toMatchObject({
    sinceSendHeadersMs: null,
    responseHeadersAfterSendMs: null,
  })
})

test('request timings remain session scoped and network listeners install once', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record')
  const clock = vi.spyOn(performance, 'now')
  const first = timingSession()
  const second = timingSession()
  installE2ENetworkErrors(first.target)
  expect(first.webRequest.onSendHeaders).toHaveBeenCalledOnce()
  expect(first.webRequest.onErrorOccurred).toHaveBeenCalledOnce()
  clock.mockReturnValue(10)
  first.webRequest.onSendHeaders.mock.calls[0][1](requestDetails)
  clock.mockReturnValue(50)
  second.webRequest.onSendHeaders.mock.calls[0][1](requestDetails)
  clock.mockReturnValue(100)
  first.webRequest.onCompleted.mock.calls[0][1]({ ...requestDetails, statusCode: 503 })
  expect(record.mock.calls.at(-1)?.[3]).toMatchObject({ sinceSendHeadersMs: 90 })
  second.webRequest.onCompleted.mock.calls[0][1]({ ...requestDetails, statusCode: 503 })
  expect(record.mock.calls.at(-1)?.[3]).toMatchObject({ sinceSendHeadersMs: 50 })
})
