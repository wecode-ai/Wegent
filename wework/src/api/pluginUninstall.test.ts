import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError, type HttpClient } from './http'
import { createPluginApi } from './plugins'
import { PLUGIN_UNINSTALL_CHECK_TIMEOUT_MS, PLUGIN_UNINSTALL_TIMEOUT_MS } from './pluginUninstall'

function setup() {
  const client = { delete: vi.fn(), get: vi.fn() }
  return { client, api: createPluginApi(client as unknown as HttpClient) }
}

afterEach(() => vi.useRealTimers())

describe('cloud plugin uninstall', () => {
  test('accepts 204 without creating another inventory read', async () => {
    const { client, api } = setup()
    client.delete.mockResolvedValue(null)
    await api.uninstallInstalledPlugin(123, 'device')
    expect(client.delete).toHaveBeenCalledWith(
      '/plugins/installed/123?device_id=device',
      undefined,
      {
        signal: expect.any(AbortSignal),
      }
    )
    expect(client.get).not.toHaveBeenCalled()
  })

  test('aborts a hung DELETE and confirms account absence, without repeating DELETE', async () => {
    vi.useFakeTimers()
    const { client, api } = setup()
    client.delete.mockImplementation(() => new Promise(() => {}))
    client.get.mockResolvedValue({ items: [] })
    const result = api.uninstallInstalledPlugin(123, 'device')
    await vi.advanceTimersByTimeAsync(PLUGIN_UNINSTALL_TIMEOUT_MS)
    await expect(result).resolves.toBeUndefined()
    expect(client.delete.mock.calls[0][2].signal.aborted).toBe(true)
    expect(client.delete).toHaveBeenCalledTimes(1)
    expect(client.get).toHaveBeenCalledWith('/plugins/installed', {
      signal: expect.any(AbortSignal),
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([
    { items: [{ metadata: { labels: { id: '123' } } }] },
    { items: [{ metadata: { labels: {} } }] },
    {},
  ])('does not assume success when account verification is inconclusive: %j', async inventory => {
    const { client, api } = setup()
    client.delete.mockRejectedValue(new TypeError('Failed to fetch'))
    client.get.mockResolvedValue(inventory)
    await expect(api.uninstallInstalledPlugin(123)).rejects.toMatchObject({
      errorCode: 'PLUGIN_UNINSTALL_UNCONFIRMED',
    })
  })

  test('bounds the verification request too and never reports a failed read as success', async () => {
    vi.useFakeTimers()
    const { client, api } = setup()
    client.delete.mockRejectedValue(new TypeError('Failed to fetch'))
    client.get.mockImplementation(() => new Promise(() => {}))
    const result = expect(api.uninstallInstalledPlugin(123)).rejects.toMatchObject({
      errorCode: 'PLUGIN_UNINSTALL_UNCONFIRMED',
    })
    await vi.advanceTimersByTimeAsync(PLUGIN_UNINSTALL_CHECK_TIMEOUT_MS)
    await result
    expect(client.get.mock.calls[0][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('preserves authorization errors without reconciling or masking them', async () => {
    const { client, api } = setup()
    const error = new ApiError('Forbidden', 403)
    client.delete.mockRejectedValue(error)
    await expect(api.uninstallInstalledPlugin(123)).rejects.toBe(error)
    expect(client.get).not.toHaveBeenCalled()
  })
})
