import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import { ChromeTitlebar } from './ChromeTitlebar'

const startDragging = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}))

vi.mock('@/components/layout/WindowFrameControls', () => ({
  WindowFrameControls: () => <div data-testid="window-frame-controls">FrameControls</div>,
}))

vi.mock('@/features/feedback/TaskFeedbackDialog', () => ({
  TaskFeedbackDialog: () => <div data-testid="task-feedback-dialog">FeedbackDialog</div>,
}))

const labels = {
  task: '任务',
  board: '项目空间',
  agent: '智能体',
  auxiliary: '工作区',
  auxiliaryRoutes: {
    plugins: '插件',
    sites: '站点',
    automations: '自动化',
    cloud: '云端工作',
    apps: '应用',
  },
}

function renderTitlebar(props: React.ComponentProps<typeof ChromeTitlebar> = {}) {
  return render(
    <WorkspaceTabsProvider pathname="/" search="" storageScope="titlebar-test" labels={labels}>
      <ChromeTitlebar {...props} />
    </WorkspaceTabsProvider>
  )
}

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
  beforeEach(() => {
    startDragging.mockClear()
    localStorage.clear()
    disableTauri()
    mockUserAgent('Mozilla/5.0')
    window.history.replaceState({}, '', '/')
  })

  test('renders the document tab strip and titlebar slots', () => {
    renderTitlebar({
      beforeTabs: <button type="button">Toggle sidebar</button>,
      afterTabs: <button type="button">Update</button>,
    })

    expect(screen.getByTestId('chrome-titlebar')).toHaveClass(
      'h-[38px]',
      'bg-[rgb(var(--color-titlebar))]'
    )
    expect(screen.getByTestId('chrome-titlebar')).not.toHaveClass(
      'backdrop-blur-xl',
      'backdrop-saturate-150'
    )
    expect(screen.getByTestId('workspace-tab-strip')).toHaveTextContent('任务')
    expect(screen.getByTestId('chrome-titlebar-before-tabs')).toHaveTextContent('Toggle sidebar')
    expect(screen.getByTestId('chrome-titlebar-after-tabs')).toHaveTextContent('Update')
    expect(screen.getByTestId('workspace-tab-strip-container')).toHaveClass('flex-1')
    expect(screen.getByTestId('titlebar-actions')).toHaveClass('h-full', 'gap-1', 'w-[5rem]')
  })

  test('shows the macOS traffic-light spacer and starts native dragging', async () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableTauri()
    renderTitlebar()

    const spacer = screen.getByTestId('macos-traffic-light-spacer')
    expect(spacer).toHaveClass('w-[92px]', 'self-stretch')
    expect(spacer.parentElement?.firstChild).toBe(spacer)

    const nativeDragRegion = within(spacer).getByTestId('macos-titlebar-drag-region')
    fireEvent.mouseDown(nativeDragRegion, { button: 0 })
    await waitFor(() => expect(startDragging).toHaveBeenCalledTimes(1))

    const fixedActions = screen.getByTestId('titlebar-fixed-actions')
    expect(fixedActions).toHaveStyle({ width: '6.75rem' })
    expect(screen.getByTestId('titlebar-actions').nextElementSibling).toBe(
      screen.getByTestId('titlebar-feedback')
    )
    expect(screen.getByTestId('titlebar-feedback')).toContainElement(
      screen.getByTestId('topnav-feedback-button')
    )
  })

  test('shows custom window controls on Windows', () => {
    mockUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    enableTauri()
    renderTitlebar()

    expect(screen.getByTestId('window-frame-controls')).toBeInTheDocument()
    expect(screen.queryByTestId('macos-traffic-light-spacer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('topnav-feedback-button')).not.toBeInTheDocument()
  })

  test('can hide workbench portals without removing the document tabs', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableTauri()
    renderTitlebar({ showWorkspacePortals: false, showFeedback: false })

    expect(screen.getByTestId('workspace-tab-strip')).toBeInTheDocument()
    expect(screen.queryByTestId('titlebar-actions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('titlebar-right-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('titlebar-fixed-actions')).toHaveStyle({ width: '1.75rem' })
    expect(screen.getByTestId('titlebar-feedback')).toBeEmptyDOMElement()
  })
})
