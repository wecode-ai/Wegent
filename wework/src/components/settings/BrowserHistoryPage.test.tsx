import '@/i18n'
import type { EmbeddedBrowserHistoryEntry } from '@/lib/embedded-browser-history'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
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

  test('shows an error state with retry when loading fails', async () => {
    searchHistoryMock.mockRejectedValue(new Error('unavailable'))
    render(<BrowserHistoryPage />)
    expect(await screen.findByTestId('browser-history-load-error')).toBeInTheDocument()
    searchHistoryMock.mockResolvedValue(sampleEntries)
    await userEvent.click(screen.getByTestId('browser-history-retry-button'))
    expect(await screen.findByText('Rust Book')).toBeInTheDocument()
  })
})
