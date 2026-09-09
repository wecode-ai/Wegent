import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { RightWorkspacePanel } from './RightWorkspacePanel'

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
