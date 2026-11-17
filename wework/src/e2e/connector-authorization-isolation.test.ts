// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { verifyConnectorAuthorizationIsolation } from './connector-authorization-isolation'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))

beforeEach(() => {
  vi.mocked(invokeDesktopHost).mockReset()
  vi.mocked(invokeDesktopHost).mockResolvedValue({ open: true })
})

test('keeps both real-window requests open until the probe completes', async () => {
  await verifyConnectorAuthorizationIsolation('http://localhost:9999')
  const calls = vi.mocked(invokeDesktopHost).mock.calls
  expect(calls.map(([method]) => method)).toEqual([
    'auth.openConnectorAuthorization',
    'auth.openConnectorAuthorization',
    'auth.getConnectorAuthorizationState',
    'auth.getConnectorAuthorizationState',
    'auth.closeConnectorAuthorization',
    'auth.closeConnectorAuthorization',
  ])
  expect(calls[0][1]?.requestId).not.toBe(calls[1][1]?.requestId)
})

test('closes both attempts when opening the second fails', async () => {
  vi.mocked(invokeDesktopHost)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('load failed'))
  await expect(verifyConnectorAuthorizationIsolation('http://localhost:9999')).rejects.toThrow(
    'load failed'
  )
  expect(
    vi
      .mocked(invokeDesktopHost)
      .mock.calls.slice(-2)
      .map(([method]) => method)
  ).toEqual(['auth.closeConnectorAuthorization', 'auth.closeConnectorAuthorization'])
})
