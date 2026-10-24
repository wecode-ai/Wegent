import { describe, expect, test, vi } from 'vitest'
import {
  LocalConnectorPluginSyncTimeoutError,
  waitForLocalConnectorAuthAvailability,
} from './waitForLocalConnectorAuthAvailability'

const target = {
  pluginKey: 'dingtalk',
  connectorSlug: 'dingtalk',
}

describe('waitForLocalConnectorAuthAvailability', () => {
  test('waits for an installed plugin to become visible before probing authorization', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("plugin_not_installed: Installed plugin 'dingtalk' was not found")
      )
      .mockRejectedValueOnce(
        new Error("plugin_not_installed: Installed plugin 'dingtalk' was not found")
      )
      .mockResolvedValue({ status: 'need_login' })
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      waitForLocalConnectorAuthAvailability(target, {
        maxAttempts: 3,
        retryIntervalMs: 25,
        probe,
        wait,
      })
    ).resolves.toEqual({ status: 'need_login' })

    expect(probe).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenNthCalledWith(1, 25)
  })

  test('does not hide a real local authorization command error', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('localAuth command returned empty output'))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(waitForLocalConnectorAuthAvailability(target, { probe, wait })).rejects.toThrow(
      'localAuth command returned empty output'
    )

    expect(probe).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })

  test('retries when the executor reports the missing plugin as a transport code', async () => {
    const missing = new Error("Installed plugin 'dingtalk' was not found on this device")
    Object.assign(missing, { code: 'plugin_not_installed' })
    const probe = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue({ status: 'need_login' })
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      waitForLocalConnectorAuthAvailability(target, {
        maxAttempts: 2,
        retryIntervalMs: 25,
        probe,
        wait,
      })
    ).resolves.toEqual({ status: 'need_login' })

    expect(probe).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenNthCalledWith(1, 25)
  })

  test('returns a typed timeout after the local install never appears', async () => {
    const probe = vi
      .fn()
      .mockRejectedValue(new Error('plugin_not_installed: Installed plugin was not found'))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      waitForLocalConnectorAuthAvailability(target, {
        maxAttempts: 2,
        probe,
        wait,
      })
    ).rejects.toBeInstanceOf(LocalConnectorPluginSyncTimeoutError)

    expect(probe).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
  })
})
