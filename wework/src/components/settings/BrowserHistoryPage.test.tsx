import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { EmbeddedBrowserHistoryEntry } from '@/lib/embedded-browser-history'
import { BrowserHistoryPage } from './BrowserHistoryPage'

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

function entry(
  id: string,
  url: string,
  visitTimeMs: number,
  title: string | null = null
): EmbeddedBrowserHistoryEntry {
  return { id, url, title, visitTimeMs }
}

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

  test('shows the empty state when no history exists', async () => {
    searchHistoryMock.mockResolvedValue([])
    render(<BrowserHistoryPage />)
    expect(await screen.findByTestId('browser-history-empty')).toBeInTheDocument()
    expect(screen.getByText('暂无浏览历史')).toBeInTheDocument()
  })

  test('groups entries by day with only the newest group expanded', async () => {
    render(<BrowserHistoryPage />)
    expect(await screen.findByText('Rust Book')).toBeInTheDocument()
    expect(screen.queryByText('Old Site')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/browser-history-group-toggle-/)).toHaveLength(2)
  })

  test('keeps loaded entries visible without flashing back to loading', async () => {
    render(<BrowserHistoryPage />)
    expect(await screen.findByText('Rust Book')).toBeInTheDocument()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(screen.getByText('Rust Book')).toBeInTheDocument()
    expect(screen.queryByTestId('browser-history-loading')).not.toBeInTheDocument()
    expect(searchHistoryMock).toHaveBeenCalledTimes(1)
  })

  test('expands a collapsed day group on toggle', async () => {
    render(<BrowserHistoryPage />)
    await screen.findByText('Rust Book')
    const toggles = screen.getAllByTestId(/browser-history-group-toggle-/)
    await userEvent.click(toggles[1])
    expect(await screen.findByText('Old Site')).toBeInTheDocument()
  })

  test('debounces search input before querying', async () => {
    render(<BrowserHistoryPage />)
    await screen.findByText('Rust Book')
    await userEvent.type(screen.getByTestId('browser-history-search'), 'rust')
    await waitFor(() => expect(searchHistoryMock).toHaveBeenCalledWith('rust'))
  })

  test('opens an entry from the row menu', async () => {
    render(<BrowserHistoryPage />)
    await screen.findByText('Rust Book')
    await userEvent.click(screen.getByTestId('browser-history-entry-menu-history-1'))
    await userEvent.click(await screen.findByTestId('browser-history-entry-open-history-1'))
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/'))
  })

  test('removes a single entry from the row menu', async () => {
    render(<BrowserHistoryPage />)
    await screen.findByText('Rust Book')
    await userEvent.click(screen.getByTestId('browser-history-entry-menu-history-1'))
    await userEvent.click(await screen.findByTestId('browser-history-entry-remove-history-1'))
    await waitFor(() => expect(removeEntriesMock).toHaveBeenCalledWith(['history-1']))
  })

  test('removes selected entries in bulk', async () => {
    render(<BrowserHistoryPage />)
    await screen.findByText('Rust Book')
    await userEvent.click(screen.getByTestId('browser-history-entry-select-history-1'))
    await userEvent.click(await screen.findByTestId('browser-history-remove-selected'))
    await waitFor(() => expect(removeEntriesMock).toHaveBeenCalledWith(['history-1']))
  })

  test('shows an error state with retry when loading fails', async () => {
    searchHistoryMock.mockRejectedValue(new Error('unavailable'))
    render(<BrowserHistoryPage />)
    expect(await screen.findByTestId('browser-history-load-error')).toBeInTheDocument()
    searchHistoryMock.mockResolvedValue(sampleEntries)
    await userEvent.click(screen.getByTestId('browser-history-retry-button'))
    expect(await screen.findByText('Rust Book')).toBeInTheDocument()
  })

  test('clears browsing data from the dialog', async () => {
    render(<BrowserHistoryPage />)
    await screen.findByText('Rust Book')
    await userEvent.click(screen.getByTestId('browser-history-clear-data-button'))
    await userEvent.click(await screen.findByTestId('browser-clear-data-confirm'))
    await waitFor(() => expect(clearDataMock).toHaveBeenCalled())
  })
})
