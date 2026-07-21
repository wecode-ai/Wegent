import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { EmbeddedBrowserDownloadEvent } from './embedded-browser'
import {
  readEmbeddedBrowserDownloadSnapshot,
  resetEmbeddedBrowserDownloadStoreForTests,
  subscribeEmbeddedBrowserDownloadEvents,
} from './embedded-browser-download-store'

const embeddedBrowserMocks = vi.hoisted(() => ({
  listenEmbeddedBrowserDownloads: vi.fn(),
}))

vi.mock('./embedded-browser', () => embeddedBrowserMocks)

function downloadEvent(
  overrides: Partial<EmbeddedBrowserDownloadEvent> = {}
): EmbeddedBrowserDownloadEvent {
  return {
    id: 'download-1',
    label: 'workspace-browser',
    nativeLabel: 'workspace-browser-native-1',
    url: 'https://example.com/app.dmg',
    path: '/Users/test/Downloads/app.dmg',
    status: 'progress',
    receivedBytes: 512,
    totalBytes: 1024,
    ...overrides,
  }
}

describe('embedded browser download store', () => {
  beforeEach(() => {
    resetEmbeddedBrowserDownloadStoreForTests()
    vi.clearAllMocks()
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockReset()
  })

  afterEach(() => {
    resetEmbeddedBrowserDownloadStoreForTests()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('keeps the native listener alive across a subscriber handoff gap', async () => {
    let handleNativeEvent!: (event: EmbeddedBrowserDownloadEvent) => void
    const unlisten = vi.fn()
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleNativeEvent = handler
      return Promise.resolve(unlisten)
    })

    const unsubscribeSource = subscribeEmbeddedBrowserDownloadEvents(vi.fn())
    await Promise.resolve()
    handleNativeEvent(downloadEvent())

    unsubscribeSource()
    expect(unlisten).not.toHaveBeenCalled()
    handleNativeEvent(downloadEvent({ status: 'finished', receivedBytes: 1024 }))

    const unsubscribeDestination = subscribeEmbeddedBrowserDownloadEvents(vi.fn())
    expect(embeddedBrowserMocks.listenEmbeddedBrowserDownloads).toHaveBeenCalledTimes(1)
    expect(readEmbeddedBrowserDownloadSnapshot('workspace-browser-native-1')).toEqual([
      downloadEvent({ status: 'finished', receivedBytes: 1024 }),
    ])
    unsubscribeDestination()
  })

  test('retries a rejected listener registration while a subscriber remains', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads
      .mockRejectedValueOnce(new Error('temporary registration failure'))
      .mockResolvedValueOnce(vi.fn())

    const unsubscribe = subscribeEmbeddedBrowserDownloadEvents(vi.fn())
    await Promise.resolve()
    await vi.runOnlyPendingTimersAsync()

    expect(embeddedBrowserMocks.listenEmbeddedBrowserDownloads).toHaveBeenCalledTimes(2)
    unsubscribe()
    consoleError.mockRestore()
  })

  test('continues retrying after four failures while the same subscriber remains', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let handleNativeEvent!: (event: EmbeddedBrowserDownloadEvent) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads
      .mockRejectedValueOnce(new Error('registration failure 1'))
      .mockRejectedValueOnce(new Error('registration failure 2'))
      .mockRejectedValueOnce(new Error('registration failure 3'))
      .mockRejectedValueOnce(new Error('registration failure 4'))
      .mockImplementationOnce(handler => {
        handleNativeEvent = handler
        return Promise.resolve(vi.fn())
      })

    const subscriber = vi.fn()
    const unsubscribe = subscribeEmbeddedBrowserDownloadEvents(subscriber)
    await Promise.resolve()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersToNextTimerAsync()
    }

    expect(embeddedBrowserMocks.listenEmbeddedBrowserDownloads).toHaveBeenCalledTimes(5)
    handleNativeEvent(downloadEvent({ status: 'finished', receivedBytes: 1024 }))
    expect(subscriber).toHaveBeenCalledWith(
      downloadEvent({ status: 'finished', receivedBytes: 1024 })
    )
    unsubscribe()
    consoleError.mockRestore()
  })

  test('cancels a pending retry when the final subscriber leaves', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockRejectedValueOnce(
      new Error('registration failure')
    )

    const unsubscribe = subscribeEmbeddedBrowserDownloadEvents(vi.fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)

    unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
    await vi.runAllTimersAsync()
    expect(embeddedBrowserMocks.listenEmbeddedBrowserDownloads).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  test('allows a later subscriber to retry after listener registration is unavailable', () => {
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads
      .mockReturnValueOnce(null)
      .mockResolvedValueOnce(vi.fn())

    const unsubscribeFirst = subscribeEmbeddedBrowserDownloadEvents(vi.fn())
    const unsubscribeSecond = subscribeEmbeddedBrowserDownloadEvents(vi.fn())

    expect(embeddedBrowserMocks.listenEmbeddedBrowserDownloads).toHaveBeenCalledTimes(2)
    unsubscribeFirst()
    unsubscribeSecond()
  })

  test('bounds histories by distinct downloads and native browser identities', () => {
    let handleNativeEvent!: (event: EmbeddedBrowserDownloadEvent) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleNativeEvent = handler
      return Promise.resolve(vi.fn())
    })
    const unsubscribe = subscribeEmbeddedBrowserDownloadEvents(vi.fn())

    Array.from({ length: 21 }, (_, index) => index).forEach(index => {
      handleNativeEvent(downloadEvent({ id: `download-${index}` }))
    })
    expect(readEmbeddedBrowserDownloadSnapshot('workspace-browser-native-1')).toHaveLength(20)
    expect(
      readEmbeddedBrowserDownloadSnapshot('workspace-browser-native-1').some(
        event => event.id === 'download-0'
      )
    ).toBe(false)

    Array.from({ length: 21 }, (_, index) => index).forEach(index => {
      handleNativeEvent(
        downloadEvent({ id: `native-download-${index}`, nativeLabel: `native-${index}` })
      )
    })
    expect(readEmbeddedBrowserDownloadSnapshot('workspace-browser-native-1')).toEqual([])
    unsubscribe()
  })

  test('removes deleted downloads from retained snapshots', () => {
    let handleNativeEvent!: (event: EmbeddedBrowserDownloadEvent) => void
    embeddedBrowserMocks.listenEmbeddedBrowserDownloads.mockImplementation(handler => {
      handleNativeEvent = handler
      return Promise.resolve(vi.fn())
    })
    const unsubscribe = subscribeEmbeddedBrowserDownloadEvents(vi.fn())

    handleNativeEvent(downloadEvent())
    handleNativeEvent(downloadEvent({ status: 'deleted' }))

    expect(readEmbeddedBrowserDownloadSnapshot('workspace-browser-native-1')).toEqual([])
    unsubscribe()
  })
})
