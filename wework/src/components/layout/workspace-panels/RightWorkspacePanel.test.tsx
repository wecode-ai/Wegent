import { render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { RightWorkspacePanel } from './RightWorkspacePanel'
import { workspaceFileTabId } from './workspaceFileTabs'
import type { WorkspaceTarget } from '@/types/workspace-files'

vi.mock('./WorkspaceBrowserPanelContainer', () => ({
  WorkspaceBrowserPanel: ({
    active,
    transferredUrl,
    onUrlChange,
  }: {
    active: boolean
    transferredUrl?: string | null
    onUrlChange?: (url: string | null) => void
  }) => (
    <button
      type="button"
      data-testid="workspace-browser-panel"
      data-active={String(active)}
      data-transferred-url={transferredUrl ?? ''}
      onClick={() => onUrlChange?.('https://example.test/next')}
    />
  ),
}))

vi.mock('./WorkspaceAddMenu', () => ({
  WorkspaceAddMenu: () => <button data-testid="right-workspace-new-tab-button" />,
}))

const browserState = {
  label: 'workspace-browser-runtime-1',
  browserSessionId: '1',
  url: 'https://www.baidu.com/',
  title: 'Baidu',
  faviconUrl: null,
  isLoading: false,
  hasActiveDownload: false,
  openRequest: null,
}

function renderPanel(overrides: Partial<ComponentProps<typeof RightWorkspacePanel>> = {}) {
  const noop = vi.fn()
  return render(
    <RightWorkspacePanel
      visible
      renderTabsInAppTitlebar={false}
      activeView="browser:1"
      openTabs={['browser:1']}
      currentProject={null}
      canBrowseFiles
      currentRuntimeTask={null}
      devices={[]}
      workspaceTarget={null}
      workspaceFileApi={{} as ComponentProps<typeof RightWorkspacePanel>['workspaceFileApi']}
      workspaceTargetError="Workspace is not ready"
      review={{ loading: false, diff: '' }}
      extensionScope={{ sessionId: 'test' }}
      browserStates={{ 'browser:1': browserState }}
      onBrowserStateChange={noop}
      canOpenReview={false}
      onAddCodeComment={noop}
      onSelectReview={noop}
      onSelectTerminal={noop}
      onSelectBrowser={noop}
      onSelectFiles={noop}
      onSelectChat={noop}
      onSelectPlan={noop}
      onSelectTab={noop}
      onCloseTab={noop}
      {...overrides}
    />
  )
}

describe('RightWorkspacePanel workspace target errors', () => {
  test('does not mount the file error beside an active browser', () => {
    renderPanel()

    expect(screen.getByTestId('workspace-browser-panel')).toHaveAttribute('data-active', 'true')
    expect(screen.queryByTestId('workspace-target-error')).not.toBeInTheDocument()
    expect(screen.queryByText('Workspace is not ready')).not.toBeInTheDocument()
  })

  test('passes the transferred URL into the first browser render', () => {
    const onBrowserStateChange = vi.fn()
    renderPanel({
      browserTransferSourceLabels: { 'browser:1': 'workspace-browser-blank-0' },
      onBrowserStateChange,
    })

    const browserPanel = screen.getByTestId('workspace-browser-panel')
    expect(browserPanel).toHaveAttribute('data-transferred-url', 'https://www.baidu.com/')
    browserPanel.click()
    expect(onBrowserStateChange).toHaveBeenCalledWith('browser:1', {
      url: 'https://example.test/next',
    })
  })

  test('shows the workspace target error on the files tab', () => {
    renderPanel({
      activeView: 'files',
      openTabs: ['files'],
      browserStates: {},
    })

    expect(screen.getByTestId('workspace-target-error')).toHaveTextContent('Workspace is not ready')
  })
})

describe('RightWorkspacePanel file tab labels', () => {
  test('shows the current file name and type icon on the original and additional tabs', () => {
    const target: WorkspaceTarget = {
      deviceId: 'fixture-device',
      path: '/fixture/repo',
      source: 'project',
      workspaceSource: 'local',
    }
    const path = '/fixture/repo/main.ts'
    const tab = workspaceFileTabId(target, path)
    renderPanel({
      openTabs: ['files', tab, 'browser:1'],
      initialFileSelection: { path: '/fixture/repo/api.py', isDirectory: false },
      fileTabs: { [tab]: { target, path } },
    })
    const pythonTab = screen.getByRole('tab', { name: /api.py/ })
    expect(pythonTab).toHaveAttribute('title', '/fixture/repo/api.py')
    expect(within(pythonTab).getByTestId('right-workspace-file-tab-icon')).toHaveAttribute(
      'data-file-icon',
      'python'
    )
    const tsTab = screen.getByRole('tab', { name: /main.ts/ })
    expect(tsTab.querySelector('[data-file-icon="typescript"] path')).not.toBeNull()
  })

  test('shows the requested file before the initial preview selection is ready', () => {
    renderPanel({
      openTabs: ['files', 'browser:1'],
      openFileRequest: { id: 1, path: '/fixture/repo/api.py' },
    })
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveTextContent('api.py')
    expect(screen.getByTestId('right-workspace-file-tab-icon')).toHaveAttribute(
      'data-file-icon',
      'python'
    )
  })

  test('uses the actual selected file after a directory open request', () => {
    renderPanel({
      openTabs: ['files', 'browser:1'],
      initialFileSelection: { path: '/fixture/repo/api.py', isDirectory: false },
      openFileRequest: { id: 1, path: '/fixture/repo', isDirectory: true },
    })
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveTextContent('api.py')
    expect(screen.getByTestId('right-workspace-file-tab-icon')).toHaveAttribute(
      'data-file-icon',
      'python'
    )
  })

  test('an attachment replaces the previous selection in the file tab title', () => {
    renderPanel({
      openTabs: ['files', 'browser:1'],
      initialFileSelection: { path: '/fixture/repo/api.py', isDirectory: false },
      openFileRequest: {
        id: 1,
        path: 'report.md',
        attachment: {
          filename: 'report.md',
          contentType: 'text/markdown',
          loadFile: async () => new Blob(),
        },
      },
    })
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveTextContent('report.md')
    expect(screen.getByTestId('right-workspace-file-tab-icon')).toHaveAttribute(
      'data-file-icon',
      'markdown'
    )
  })

  test.each([null, { path: '/fixture/repo', isDirectory: true }])(
    'keeps the generic tab only when no file is selected: %j',
    initialFileSelection => {
      renderPanel({ openTabs: ['files', 'browser:1'], initialFileSelection })
      expect(screen.getByTestId('right-workspace-file-tab-icon')).not.toHaveAttribute(
        'data-file-icon'
      )
      expect(screen.getByTestId('right-workspace-file-tab')).not.toHaveAttribute('title')
    }
  )
})
