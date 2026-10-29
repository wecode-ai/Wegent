import { beforeEach, describe, expect, test, vi } from 'vitest'
import { executeVerificationControlCommand } from './verification-control'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('@/desktop/localExecutor', () => ({ requestLocalExecutor: request }))
vi.mock('@/lib/local-terminal', () => ({ getLocalTerminalSnapshot: vi.fn() }))
vi.mock('@/api/local/localConnectorAuth', () => ({
  localConnectorAuthHealth: vi.fn(),
  localConnectorAuthLogout: vi.fn(),
  localConnectorAuthStart: vi.fn(),
  localConnectorAuthPoll: vi.fn(),
}))

const disconnect = () =>
  executeVerificationControlCommand(
    { id: 'disconnect-native-cloud', action: 'disconnectLocalExecutorCloud', selector: 'body' },
    { elementEnabled: () => true }
  )

beforeEach(() => request.mockReset())

describe('real Native cloud disconnect verification command', () => {
  test('removes the Native profile and reads the resulting connection state without credentials', async () => {
    request.mockResolvedValueOnce({ changed: true }).mockResolvedValueOnce({
      configured: false,
      connected: false,
      auth_token: 'must-not-be-returned',
      backend_url: 'https://private.example',
    })

    const result = await disconnect()

    expect(request.mock.calls).toEqual([
      ['executor.backend.configure', {}],
      ['executor.backend.status'],
    ])
    expect(result).toEqual({
      handled: true,
      value: '{"configured":false,"connected":false}',
    })
  })

  test('propagates a failed Native disconnect instead of returning an invented offline status', async () => {
    request.mockRejectedValueOnce(new Error('Native connection command failed'))

    await expect(disconnect()).rejects.toThrow('Native connection command failed')

    expect(request).toHaveBeenCalledTimes(1)
  })

  test('returns the actual Native status so a failed disconnect remains visible to E2E', async () => {
    request.mockResolvedValueOnce({ changed: false }).mockResolvedValueOnce({
      configured: true,
      connected: true,
    })

    expect(await disconnect()).toEqual({
      handled: true,
      value: '{"configured":true,"connected":true}',
    })
  })
})
