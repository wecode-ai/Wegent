import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import { ChromeTitlebar } from './ChromeTitlebar'

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
    automations: '已安排',
    cloud: '云端工作',
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

function enableElectron() {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    ...window.__WEWORK_RUNTIME_CONFIG__,
    desktopHost: 'electron',
  }
}

describe('ChromeTitlebar', () => {
  beforeEach(() => {
    localStorage.clear()
    enableElectron()
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

  test('hides the workspace tab when its kind is not available', () => {
    renderTitlebar({
      availableWorkspaceTabKinds: ['task', 'agent', 'auxiliary'],
    })
    expect(screen.getByTestId('workspace-tab-strip')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '任务' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '智能体' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '项目空间' })).not.toBeInTheDocument()
  })

  test('shows the macOS traffic-light spacer with a native drag region', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    renderTitlebar()

    const spacer = screen.getByTestId('macos-traffic-light-spacer')
    expect(spacer).toHaveClass('w-[92px]', 'self-stretch')
    expect(spacer.parentElement?.firstChild).toBe(spacer)

    const nativeDragRegion = within(spacer).getByTestId('macos-titlebar-drag-region')
    expect(nativeDragRegion).toHaveClass('electron-titlebar-drag-region')

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
    renderTitlebar()

    expect(screen.getByTestId('window-frame-controls')).toBeInTheDocument()
    expect(screen.queryByTestId('macos-traffic-light-spacer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('topnav-feedback-button')).not.toBeInTheDocument()
  })

  test('uses the Electron macOS traffic-light layout', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableElectron()
    renderTitlebar()

    expect(screen.getByTestId('macos-traffic-light-spacer')).toHaveClass('w-[92px]', 'self-stretch')
    expect(screen.getByTestId('titlebar-fixed-actions')).toHaveStyle({
      width: '6.75rem',
    })
    expect(screen.getByTestId('titlebar-right-panel-drag-region')).toBeInTheDocument()
  })

  test('uses DSH window controls in frameless Electron windows', () => {
    mockUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    enableElectron()
    renderTitlebar()

    expect(screen.getByTestId('window-frame-controls')).toBeInTheDocument()
  })

  test('can hide workbench portals without removing the document tabs', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    renderTitlebar({ showWorkspacePortals: false, showFeedback: false })

    expect(screen.getByTestId('workspace-tab-strip')).toBeInTheDocument()
    expect(screen.queryByTestId('titlebar-actions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('titlebar-right-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('titlebar-fixed-actions')).toHaveStyle({ width: '1.75rem' })
    expect(screen.getByTestId('titlebar-feedback')).toBeEmptyDOMElement()
  })
})
