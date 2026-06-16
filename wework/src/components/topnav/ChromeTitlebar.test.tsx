import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ChromeTitlebar } from './ChromeTitlebar'
import type { AppTab } from '@/config/apps'

const mockTabs: AppTab[] = [
  { key: 'wework', label: 'WeWork', mode: 'native', requiresAuth: true },
  {
    key: 'wegent',
    label: 'Wegent',
    mode: 'iframe',
    url: 'http://localhost:3000',
    requiresAuth: true,
  },
]

function mockUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get() {
      return ua
    },
  })
}

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
}

function disableTauri() {
  delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
}

describe('ChromeTitlebar', () => {
  test('renders all tab buttons', () => {
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    expect(screen.getByTestId('chrome-tab-wework')).toBeInTheDocument()
    expect(screen.getByTestId('chrome-tab-wegent')).toBeInTheDocument()
  })

  test('active tab connects to the window canvas', () => {
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wegent" onNavigate={vi.fn()} />)
    expect(screen.getByTestId('chrome-tab-wegent')).toHaveClass('bg-black/[0.045]')
    expect(screen.getByTestId('chrome-tab-wework')).not.toHaveClass('bg-black/[0.045]')
    expect(screen.getByTestId('chrome-tab-wegent')).toHaveClass(
      'h-7',
      'min-w-24',
      'justify-center',
      'rounded-lg',
      'px-3',
      'text-center',
      'leading-none',
      'bg-black/[0.045]'
    )
    expect(screen.getByTestId('chrome-tab-wegent')).not.toHaveClass(
      'border',
      'shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
    )
    expect(screen.getByTestId('chrome-titlebar')).toHaveClass('h-[38px]', 'bg-surface')
    expect(screen.getByTestId('titlebar-actions')).toBeInTheDocument()
  })

  test('renders after-tabs content between tabs and titlebar actions', () => {
    render(
      <ChromeTitlebar
        tabs={mockTabs}
        activeKey="wework"
        onNavigate={vi.fn()}
        afterTabs={<button type="button">Update</button>}
      />
    )

    const afterTabs = screen.getByTestId('chrome-titlebar-after-tabs')
    const activeTab = screen.getByTestId('chrome-tab-wework')
    const titlebarActions = screen.getByTestId('titlebar-actions')
    expect(afterTabs).toHaveTextContent('Update')
    expect(
      activeTab.compareDocumentPosition(afterTabs) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      afterTabs.compareDocumentPosition(titlebarActions) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('calls onNavigate on tab click', async () => {
    const fn = vi.fn()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={fn} />)
    await userEvent.click(screen.getByTestId('chrome-tab-wegent'))
    expect(fn).toHaveBeenCalledWith('wegent')
  })

  test('shows macOS traffic light spacer in Tauri runtime on Mac', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableTauri()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    const dragRegion = screen.getByTestId('macos-traffic-light-spacer')
    expect(dragRegion.className).toContain('w-[95px]')
    // macOS spacer is first child (left side)
    expect(dragRegion?.parentElement?.firstChild).toBe(dragRegion)
    disableTauri()
  })

  test('shows right spacer in Tauri runtime on Windows', () => {
    mockUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    enableTauri()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    const dragRegion = document.querySelector('[data-tauri-drag-region]')
    expect(dragRegion).toBeInTheDocument()
    // Windows spacer is last child (right side)
    expect(dragRegion?.parentElement?.lastChild).toBe(dragRegion)
    disableTauri()
  })

  test('no spacer when not in Tauri runtime', () => {
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    expect(document.querySelector('[data-tauri-drag-region]')).not.toBeInTheDocument()
  })
})
