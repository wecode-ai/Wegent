import { expect, test, vi } from 'vitest'
import type { InstalledPlugin, InstalledPluginListResponse } from '@/types/api'
import { ApiError } from '@/api/http'
import {
  waitForPluginDeviceReceipt,
  PluginDeviceReceiptTimeoutError,
  PluginInstallationSupersededError,
} from './waitForPluginDeviceReceipt'

function plugin(state: string, id = 54, release = 17, deviceId = 'device'): InstalledPlugin {
  return {
    metadata: { labels: { id } },
    spec: { releaseId: release },
    status: { devices: [{ deviceId, state, desiredReleaseId: release, actualReleaseId: release }] },
  } as InstalledPlugin
}

const current = () => true
const wait = () => Promise.resolve()

function deferredReceipt() {
  let resolve!: (response: InstalledPluginListResponse) => void
  const promise = new Promise<InstalledPluginListResponse>(done => (resolve = done))
  return { promise, resolve }
}

test.each(['missing', 'old-installed'] as const)(
  'a new install cannot use a previously dispatched GET containing %s membership',
  async previousMembership => {
    const old = deferredReceipt()
    const fresh = deferredReceipt()
    const aInstalled = plugin('installed')
    const bInstalled = plugin('installed', 55)
    const readInstalled = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise)
    const options = { readInstalled, isCurrent: current, wait }
    const a = waitForPluginDeviceReceipt(plugin('pending'), 'device', options)
    await vi.waitFor(() => expect(readInstalled).toHaveBeenCalledOnce())
    // B's POST returned pending after the server had already read A's old snapshot.
    const settledB = vi.fn()
    const b = waitForPluginDeviceReceipt(plugin('pending', 55), 'device', options).then(
      value => {
        settledB(value)
        return value
      },
      error => {
        settledB(error)
        return error
      }
    )
    const latest = { items: [aInstalled, bInstalled] } as InstalledPluginListResponse
    try {
      old.resolve({
        items: [
          aInstalled,
          ...(previousMembership === 'old-installed' ? [plugin('installed', 55)] : []),
        ],
      } as InstalledPluginListResponse)
      await a
      expect(readInstalled).toHaveBeenCalledTimes(2)
      expect(settledB).not.toHaveBeenCalled()
      fresh.resolve(latest)
      expect(await b).toBe(bInstalled)
    } finally {
      old.resolve(latest)
      fresh.resolve(latest)
      await Promise.all([a, b])
    }
  }
)

test('an older GET completion cannot make a newer dispatched GET reusable by another install', async () => {
  const old = deferredReceipt()
  const middle = deferredReceipt()
  const aInstalled = plugin('installed')
  const bInstalled = plugin('installed', 55)
  const cInstalled = plugin('installed', 56)
  const readInstalled = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(middle.promise)
    .mockResolvedValue({ items: [aInstalled, bInstalled, cInstalled] })
  const options = { readInstalled, isCurrent: current, wait }
  const a = waitForPluginDeviceReceipt(plugin('pending'), 'device', options)
  await vi.waitFor(() => expect(readInstalled).toHaveBeenCalledOnce())
  const b = waitForPluginDeviceReceipt(plugin('pending', 55), 'device', options)
  const latest = { items: [aInstalled, bInstalled, cInstalled] } as InstalledPluginListResponse
  try {
    await vi.waitFor(() => expect(readInstalled).toHaveBeenCalledTimes(2))
    old.resolve({ items: [aInstalled] } as InstalledPluginListResponse)
    await a
    const c = waitForPluginDeviceReceipt(plugin('pending', 56), 'device', options)
    // Finish B with a pre-C snapshot: only C's own fresh read can confirm it.
    middle.resolve({ items: [aInstalled, bInstalled] } as InstalledPluginListResponse)
    expect(await c).toBe(cInstalled)
    expect(readInstalled).toHaveBeenCalledTimes(3)
    expect(await b).toBe(bInstalled)
  } finally {
    old.resolve(latest)
    middle.resolve(latest)
    await Promise.all([a, b])
  }
})

test.each([
  new ApiError('Unavailable', 503),
  new ApiError('Throttled', 429),
  new TypeError('Failed to fetch'),
])('recovers from a transient receipt read failure: %s', async error => {
  const readInstalled = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ items: [plugin('installed')] })
  const delay = vi.fn(wait)
  const result = await waitForPluginDeviceReceipt(plugin('pending'), 'device', {
    readInstalled,
    isCurrent: current,
    wait: delay,
  })
  expect(result.status.devices?.[0].state).toBe('installed')
  expect(readInstalled).toHaveBeenCalledTimes(2)
  expect(delay).toHaveBeenCalledWith(1000)
})

test('persistent read failure exhausts the existing polling budget as unconfirmed, not an install failure', async () => {
  const readInstalled = vi.fn().mockRejectedValue(new ApiError('Unavailable', 503))
  const initial = plugin('pending')
  await expect(
    waitForPluginDeviceReceipt(initial, 'device', {
      readInstalled,
      isCurrent: current,
      maxAttempts: 3,
      wait,
    })
  ).rejects.toBeInstanceOf(PluginDeviceReceiptTimeoutError)
  expect(readInstalled).toHaveBeenCalledTimes(3)
  expect(initial.status.devices?.[0].state).toBe('pending')
})

test('transient errors do not extend the polling deadline', async () => {
  vi.useFakeTimers()
  const readInstalled = vi.fn().mockRejectedValue(new ApiError('Unavailable', 503))
  try {
    const pending = expect(
      waitForPluginDeviceReceipt(plugin('pending'), 'device', {
        readInstalled,
        isCurrent: current,
        timeoutMs: 1500,
      })
    ).rejects.toBeInstanceOf(PluginDeviceReceiptTimeoutError)
    await vi.advanceTimersByTimeAsync(1500)
    await pending
    expect(readInstalled).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

test.each([401, 403, 404])(
  'does not retry HTTP %s or misclassify the committed install',
  async status => {
    const error = new ApiError('Receipt unavailable', status)
    const readInstalled = vi.fn().mockRejectedValue(error)
    const delay = vi.fn(wait)
    await expect(
      waitForPluginDeviceReceipt(plugin('pending'), 'device', {
        readInstalled,
        isCurrent: current,
        wait: delay,
      })
    ).rejects.toMatchObject({ code: 'PLUGIN_DEVICE_RECEIPT_UNCONFIRMED', cause: error })
    expect(readInstalled).toHaveBeenCalledOnce()
    expect(delay).not.toHaveBeenCalled()
  }
)

test('an account change during failed polling prevents further reads and ignores the old failure', async () => {
  let active = true
  const readA = vi.fn().mockRejectedValue(new ApiError('Unavailable', 503))
  await expect(
    waitForPluginDeviceReceipt(plugin('pending'), 'device', {
      readInstalled: readA,
      isCurrent: () => active,
      wait: async () => {
        active = false
      },
    })
  ).rejects.toBeInstanceOf(PluginInstallationSupersededError)
  expect(readA).toHaveBeenCalledOnce()
  const readB = vi.fn().mockResolvedValue({ items: [plugin('installed', 54, 18)] })
  const result = await waitForPluginDeviceReceipt(plugin('pending', 54, 18), 'device', {
    readInstalled: readB,
    isCurrent: current,
  })
  expect(result.spec.releaseId).toBe(18)
  expect(readB).toHaveBeenCalledOnce()
})

test('an old failed response after an account change is discarded before error classification', async () => {
  let active = true
  const readInstalled = vi.fn().mockImplementation(async () => {
    active = false
    throw new ApiError('Not authenticated', 401)
  })
  await expect(
    waitForPluginDeviceReceipt(plugin('pending'), 'device', {
      readInstalled,
      isCurrent: () => active,
    })
  ).rejects.toBeInstanceOf(PluginInstallationSupersededError)
  expect(readInstalled).toHaveBeenCalledOnce()
})

test('an installed receipt is immediate but matching release numbers alone do not confirm pending', async () => {
  const readInstalled = vi.fn().mockResolvedValue({ items: [plugin('installed')] })
  await waitForPluginDeviceReceipt(plugin('installed'), 'device', {
    readInstalled,
    isCurrent: current,
  })
  expect(readInstalled).not.toHaveBeenCalled()
  const result = await waitForPluginDeviceReceipt(plugin('pending'), 'device', {
    readInstalled,
    isCurrent: current,
  })
  expect(result.status.devices?.[0].state).toBe('installed')
  expect(readInstalled).toHaveBeenCalledOnce()
})

test('waits through a removal snapshot and pending state until the newest receipt arrives', async () => {
  const readInstalled = vi
    .fn()
    .mockResolvedValueOnce({ items: [plugin('pending')] })
    .mockResolvedValueOnce({ items: [plugin('installed')] })
  const result = await waitForPluginDeviceReceipt(plugin('uninstalling'), 'device', {
    readInstalled,
    isCurrent: current,
    wait,
  })
  expect(result.status.devices?.[0].state).toBe('installed')
  expect(readInstalled).toHaveBeenCalledTimes(2)
})

test('shares concurrent reads on one account/device without caching completed receipts', async () => {
  let resolve!: (response: InstalledPluginListResponse) => void
  const readInstalled = vi.fn(
    () =>
      new Promise<InstalledPluginListResponse>(done => {
        resolve = done
      })
  )
  const options = { readInstalled, isCurrent: current }
  const first = waitForPluginDeviceReceipt(plugin('pending'), 'device', options)
  const second = waitForPluginDeviceReceipt(plugin('pending', 55), 'device', options)
  await vi.waitFor(() => expect(readInstalled).toHaveBeenCalledOnce())
  resolve({ items: [plugin('installed'), plugin('installed', 55)] })
  expect((await first).metadata.labels).toEqual({ id: 54 })
  expect((await second).metadata.labels).toEqual({ id: 55 })
  readInstalled.mockResolvedValue({ items: [plugin('failed')] })
  expect(
    (await waitForPluginDeviceReceipt(plugin('pending'), 'device', options)).status.devices?.[0]
      .state
  ).toBe('failed')
  expect(readInstalled).toHaveBeenCalledTimes(2)
})

test('account changes discard old reads and never share credentials across API functions', async () => {
  let active = true
  let resolve!: (response: InstalledPluginListResponse) => void
  const readA = vi.fn(
    () =>
      new Promise<InstalledPluginListResponse>(done => {
        resolve = done
      })
  )
  const readB = vi.fn().mockResolvedValue({ items: [plugin('installed', 54, 18)] })
  const old = waitForPluginDeviceReceipt(plugin('pending'), 'device', {
    readInstalled: readA,
    isCurrent: () => active,
  })
  await vi.waitFor(() => expect(readA).toHaveBeenCalledOnce())
  active = false
  const fresh = await waitForPluginDeviceReceipt(plugin('pending', 54, 18), 'device', {
    readInstalled: readB,
    isCurrent: current,
  })
  expect(fresh.spec.releaseId).toBe(18)
  resolve({ items: [plugin('installed')] })
  await expect(old).rejects.toBeInstanceOf(PluginInstallationSupersededError)
})

test('an old release or another device cannot confirm installation', async () => {
  const initial = plugin('installed')
  initial.status.devices![0].actualReleaseId = 16
  const readInstalled = vi
    .fn()
    .mockResolvedValue({ items: [plugin('installed', 54, 17, 'other-device')] })
  await expect(
    waitForPluginDeviceReceipt(initial, 'device', {
      readInstalled,
      isCurrent: current,
      maxAttempts: 2,
      wait,
    })
  ).rejects.toBeInstanceOf(PluginDeviceReceiptTimeoutError)
  expect(readInstalled).toHaveBeenCalledTimes(2)
})

test('a subsequent account uninstall supersedes the old install', async () => {
  const readInstalled = vi.fn().mockResolvedValue({ items: [] })
  await expect(
    waitForPluginDeviceReceipt(plugin('pending'), 'device', {
      readInstalled,
      isCurrent: current,
    })
  ).rejects.toBeInstanceOf(PluginInstallationSupersededError)
})

test('scope changes during a polling delay stop further requests', async () => {
  let active = true
  const readInstalled = vi.fn().mockResolvedValue({ items: [plugin('pending')] })
  await expect(
    waitForPluginDeviceReceipt(plugin('pending'), 'device', {
      readInstalled,
      isCurrent: () => active,
      wait: async () => {
        active = false
      },
    })
  ).rejects.toBeInstanceOf(PluginInstallationSupersededError)
  expect(readInstalled).toHaveBeenCalledOnce()
})

test.each(['short-first', 'long-first'] as const)(
  'shared receipt reads respect each waiter deadline independently (%s)',
  async order => {
    vi.useFakeTimers()
    let resolve!: (response: InstalledPluginListResponse) => void
    const readInstalled = vi.fn(
      () =>
        new Promise<InstalledPluginListResponse>(done => {
          resolve = done
        })
    )
    const start = (id: number, timeoutMs: number) =>
      waitForPluginDeviceReceipt(plugin('pending', id), 'device', {
        readInstalled,
        isCurrent: current,
        timeoutMs,
      })
    try {
      const first = order === 'short-first' ? start(54, 100) : start(55, 15_000)
      const second = order === 'short-first' ? start(55, 15_000) : start(54, 100)
      const short = order === 'short-first' ? first : second
      const long = order === 'short-first' ? second : first
      const shortSettled = vi.fn()
      const shortResult = short.then(
        value => shortSettled(value),
        error => shortSettled(error)
      )
      const longSettled = vi.fn()
      void long.then(longSettled, longSettled)
      await vi.advanceTimersByTimeAsync(100)
      expect(readInstalled).toHaveBeenCalledOnce()
      expect(shortSettled).toHaveBeenCalledWith(expect.any(PluginDeviceReceiptTimeoutError))
      await shortResult
      await vi.advanceTimersByTimeAsync(1000)
      expect(readInstalled).toHaveBeenCalledOnce()
      expect(longSettled).not.toHaveBeenCalled()
      resolve({ items: [plugin('installed'), plugin('installed', 55)] })
      expect((await long).metadata.labels).toEqual({ id: 55 })
      expect(readInstalled).toHaveBeenCalledOnce()
    } finally {
      resolve?.({ items: [plugin('installed'), plugin('installed', 55)] })
      vi.useRealTimers()
    }
  }
)

test('bounds a waiter independently and permits a fresh read after the shared read expires', async () => {
  vi.useFakeTimers()
  const readInstalled = vi
    .fn()
    .mockImplementationOnce(() => new Promise<InstalledPluginListResponse>(() => {}))
    .mockResolvedValue({ items: [plugin('installed')] })
  try {
    const pending = expect(
      waitForPluginDeviceReceipt(plugin('pending'), 'device', {
        readInstalled,
        isCurrent: current,
        timeoutMs: 1000,
      })
    ).rejects.toBeInstanceOf(PluginDeviceReceiptTimeoutError)
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(readInstalled).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(14_000)
    expect(
      (
        await waitForPluginDeviceReceipt(plugin('pending'), 'device', {
          readInstalled,
          isCurrent: current,
        })
      ).status.devices?.[0].state
    ).toBe('installed')
  } finally {
    vi.useRealTimers()
  }
})
