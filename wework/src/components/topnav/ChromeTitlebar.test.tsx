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

const appTabs: AppTab[] = [
  { key: 'wework', label: 'WeWork', mode: 'native', requiresAuth: true },
  { key: 'apps', label: '应用', mode: 'native', requiresAuth: true },
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
      'h-8',
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
    expect(screen.getByTestId('titlebar-actions')).toHaveClass('gap-1', 'pr-3')
  })

  test('renders app tabs as icon-only controls with hover labels', () => {
    render(<ChromeTitlebar tabs={appTabs} activeKey="wework" onNavigate={vi.fn()} iconOnlyTabs />)

    const weworkTab = screen.getByTestId('chrome-tab-wework')
    const appsTab = screen.getByTestId('chrome-tab-apps')

    expect(weworkTab).toHaveClass('w-8', 'min-w-0', 'px-0')
    expect(appsTab).toHaveClass('w-8', 'min-w-0', 'px-0')
    expect(weworkTab).toHaveAttribute('title', 'WeWork')
    expect(appsTab).toHaveAttribute('title', '应用')
    expect(weworkTab.querySelector('.sr-only')).toHaveTextContent('WeWork')
    expect(appsTab.querySelector('.sr-only')).toHaveTextContent('应用')
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

  test('renders before-tabs content between traffic lights and tabs', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableTauri()
    render(
      <ChromeTitlebar
        tabs={mockTabs}
        activeKey="wework"
        onNavigate={vi.fn()}
        beforeTabs={<button type="button">Toggle sidebar</button>}
      />
    )

    const spacer = screen.getByTestId('macos-traffic-light-spacer')
    const beforeTabs = screen.getByTestId('chrome-titlebar-before-tabs')
    const activeTab = screen.getByTestId('chrome-tab-wework')
    const toggleButton = screen.getByRole('button', { name: 'Toggle sidebar' })
    expect(beforeTabs).toHaveTextContent('Toggle sidebar')
    expect(screen.getByTestId('chrome-titlebar')).not.toHaveAttribute('data-tauri-drag-region')
    expect(toggleButton.closest('[data-tauri-drag-region]')).toBeNull()
    expect(activeTab.closest('[data-tauri-drag-region]')).toBeNull()
    expect(
      spacer.compareDocumentPosition(beforeTabs) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      beforeTabs.compareDocumentPosition(activeTab) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    disableTauri()
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
    const dragRegion = screen.getByTestId('chrome-titlebar').lastElementChild
    expect(dragRegion).toBeInTheDocument()
    expect(dragRegion).toHaveAttribute('data-tauri-drag-region')
    expect(dragRegion).toHaveClass('w-[138px]')
    // Windows spacer is last child (right side)
    expect(dragRegion?.parentElement?.lastChild).toBe(dragRegion)
    disableTauri()
  })

  test('no spacer when not in Tauri runtime', () => {
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    expect(document.querySelector('[data-tauri-drag-region]')).not.toBeInTheDocument()
  })
})
