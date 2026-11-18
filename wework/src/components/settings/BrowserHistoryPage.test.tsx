import i18n from '@/i18n'
import type { EmbeddedBrowserHistoryEntry } from '@/lib/embedded-browser-history'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BrowserHistoryPage } from './BrowserHistoryPage'
import { historyEntry as entry, historyEntries } from './browserHistory.testFixtures'

const searchHistoryMock = vi.hoisted(() => vi.fn())
const removeEntriesMock = vi.hoisted(() => vi.fn())
const clearDataMock = vi.hoisted(() => vi.fn())
const requestOpenMock = vi.hoisted(() => vi.fn())
const navigateToMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/embedded-browser-history', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/embedded-browser-history')>()
  return {
    ...actual,
    searchEmbeddedBrowserHistory: searchHistoryMock,
    removeEmbeddedBrowserHistoryEntries: removeEntriesMock,
  }
})

vi.mock('@/lib/embedded-browser', () => ({
  clearEmbeddedBrowserData: clearDataMock,
  requestEmbeddedBrowserOpen: requestOpenMock,
}))

vi.mock('@/lib/navigation', () => ({
  navigateTo: navigateToMock,
  toBrowserPath: (path: string) => path,
}))

const today = new Date()
const todayNoon = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate(),
  12,
  0,
  0
).getTime()

const sampleEntries: EmbeddedBrowserHistoryEntry[] = [
  entry('history-1', 'https://docs.example/rust', todayNoon + 6000, 'Rust Book'),
  entry('history-2', 'https://news.example/', todayNoon, null),
  entry('history-3', 'https://old.example/', todayNoon - 3 * 86_400_000, 'Old Site'),
]

describe('BrowserHistoryPage', () => {
  beforeEach(() => {
    searchHistoryMock.mockReset()
    removeEntriesMock.mockReset()
    clearDataMock.mockReset()
    requestOpenMock.mockReset()
    navigateToMock.mockReset()
    searchHistoryMock.mockResolvedValue(sampleEntries)
    removeEntriesMock.mockResolvedValue(1)
    clearDataMock.mockResolvedValue(1)
    requestOpenMock.mockReturnValue(true)
  })

  test('shows an error state with retry when loading fails', async () => {
    searchHistoryMock.mockRejectedValue(new Error('unavailable'))
    render(<BrowserHistoryPage />)
    expect(await screen.findByTestId('browser-history-load-error')).toBeInTheDocument()
    searchHistoryMock.mockResolvedValue(sampleEntries)
    await userEvent.click(screen.getByTestId('browser-history-retry-button'))
    expect(await screen.findByText('Rust Book')).toBeInTheDocument()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

class HistoryObserver {
  static instances: HistoryObserver[] = []
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(private callback: IntersectionObserverCallback) {
    HistoryObserver.instances.push(this)
  }
  trigger() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    )
  }
}

function prepareHistory() {
  searchHistoryMock.mockReset().mockResolvedValue(historyEntries())
  removeEntriesMock.mockReset().mockResolvedValue(1)
  clearDataMock.mockReset().mockResolvedValue(1)
  HistoryObserver.instances = []
  vi.stubGlobal('IntersectionObserver', HistoryObserver)
}

test('wires the search field to the latest debounced native query', async () => {
  prepareHistory()
  render(<BrowserHistoryPage />)
  await screen.findByText('history 0')
  vi.useFakeTimers()
  searchHistoryMock.mockResolvedValueOnce(historyEntries(1, 'latest'))
  fireEvent.change(screen.getByTestId('browser-history-search'), { target: { value: 'latest' } })
  await act(async () => vi.advanceTimersByTimeAsync(199))
  expect(searchHistoryMock).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(searchHistoryMock).toHaveBeenLastCalledWith('latest')
  expect(screen.getByText('latest 0')).toBeInTheDocument()
  expect(screen.queryByText('history 0')).not.toBeInTheDocument()
})

test('suspends automatic pagination on failure and retries only from the explicit control', async () => {
  prepareHistory()
  searchHistoryMock
    .mockResolvedValueOnce(historyEntries())
    .mockRejectedValueOnce(new Error('Pagination failed'))
    .mockResolvedValueOnce([])
  render(<BrowserHistoryPage />)
  await screen.findByTestId('browser-history-load-more-sentinel')
  const observer = HistoryObserver.instances.at(-1)!
  act(() => observer.trigger())
  await screen.findByTestId('browser-history-pagination-error')
  act(() => {
    observer.trigger()
    observer.trigger()
  })
  expect(searchHistoryMock).toHaveBeenCalledTimes(2)
  expect(screen.getByText('history 0')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('browser-history-pagination-retry-button'))
  await waitFor(() =>
    expect(screen.queryByTestId('browser-history-pagination-error')).not.toBeInTheDocument()
  )
  expect(searchHistoryMock).toHaveBeenCalledTimes(3)
})

test('observes the next cursor after a successful page and ignores the detached observer', async () => {
  prepareHistory()
  const first = historyEntries(),
    next = historyEntries(100, 'next', first[99].visitTimeMs - 1)
  searchHistoryMock
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(next)
    .mockResolvedValueOnce([])
  render(<BrowserHistoryPage />)
  await screen.findByTestId('browser-history-load-more-sentinel')
  const firstObserver = HistoryObserver.instances.at(-1)!
  act(() => firstObserver.trigger())
  await screen.findByText('next 0')
  const nextObserver = HistoryObserver.instances.at(-1)!
  expect(nextObserver).not.toBe(firstObserver)
  act(() => firstObserver.trigger())
  expect(searchHistoryMock).toHaveBeenCalledTimes(2)
  act(() => nextObserver.trigger())
  await waitFor(() =>
    expect(screen.queryByTestId('browser-history-load-more-sentinel')).not.toBeInTheDocument()
  )
  expect(searchHistoryMock).toHaveBeenCalledTimes(3)
})

test('retains selections and date-group state through language changes without another native read', async () => {
  prepareHistory()
  render(<BrowserHistoryPage />)
  await screen.findByText('history 0')
  await userEvent.click(screen.getByTestId('browser-history-entry-select-history-0'))
  const previousLanguage = i18n.language
  try {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(screen.getByTestId('browser-history-entry-select-history-0')).toBeChecked()
    expect(searchHistoryMock).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})
