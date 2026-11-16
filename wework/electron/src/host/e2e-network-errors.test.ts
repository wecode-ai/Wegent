import type { Session } from 'electron'
import { afterEach, expect, test, vi } from 'vitest'
import { e2eErrorLog } from './e2e-error-log.js'
import { installE2ENetworkErrors } from './e2e-network-errors.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('observes connection failures and HTTP failures without collecting query credentials', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const record = vi.spyOn(e2eErrorLog, 'record')
  const webRequest = { onErrorOccurred: vi.fn(), onCompleted: vi.fn() }
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
  const webRequest = { onErrorOccurred: vi.fn(), onCompleted: vi.fn() }
  installE2ENetworkErrors({ webRequest } as unknown as Session)
  expect(webRequest.onErrorOccurred).not.toHaveBeenCalled()
  expect(webRequest.onCompleted).not.toHaveBeenCalled()
})
