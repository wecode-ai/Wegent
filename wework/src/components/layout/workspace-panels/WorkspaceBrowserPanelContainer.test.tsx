import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkspaceBrowserPanelProps } from './WorkspaceBrowserPanel'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanelContainer'

const browserPanelMocks = vi.hoisted(() => ({
  lastProps: null as WorkspaceBrowserPanelProps | null,
}))

vi.mock('./WorkspaceBrowserPanel', () => ({
  WorkspaceBrowserTabPanel: (props: WorkspaceBrowserPanelProps) => {
    browserPanelMocks.lastProps = props
    return <div data-testid="browser-host">{props.label}</div>
  },
}))

describe('WorkspaceBrowserPanelContainer', () => {
  beforeEach(() => {
    browserPanelMocks.lastProps = null
  })

  test('forwards browser host props without creating nested browser tabs', () => {
    const openRequest = {
      id: 'open-request-1',
      url: 'https://example.test/',
      baseLabel: 'workspace-browser-task-1',
      source: 'user' as const,
      disposition: 'new-tab' as const,
    }

    const onTitleChange = vi.fn()
    const onNativeLabelChange = vi.fn()

    render(
      <WorkspaceBrowserPanel
        active
        label="workspace-browser-task-1"
        openRequest={openRequest}
        onTitleChange={onTitleChange}
        onNativeLabelChange={onNativeLabelChange}
      />
    )

    expect(screen.getByTestId('browser-host')).toHaveTextContent('workspace-browser-task-1')
    expect(browserPanelMocks.lastProps).toMatchObject({
      active: true,
      label: 'workspace-browser-task-1',
      openRequest,
      onTitleChange,
      onNativeLabelChange,
    })
  })
})
