import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'

import { BottomWorkspacePanel } from './BottomWorkspacePanel'

vi.mock('./WorkspacePanelCards', () => ({
  WorkspacePanelCards: () => <div data-testid="workspace-panel-cards" />,
}))

vi.mock('./useResizableWorkspacePanel', () => ({
  useResizableBottomPanel: () => ({
    handleResizeStart: vi.fn(),
    height: 320,
    panelRef: { current: null },
    resizing: false,
  }),
}))

const extensionTabs = [
  {
    icon: 'blocks',
    id: 'quality.bottom-panel',
    label: 'Quality',
    order: 10,
  },
]

describe('BottomWorkspacePanel extensions', () => {
  beforeEach(() => {
    window.__WEWORK_DSH_UI__ = {
      attach: () => ({ dispose: () => {}, update: () => {} }),
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.workspaceBottomPanelTab ? extensionTabs : []),
      subscribe: () => () => {},
    }
  })

  test('renders and selects contributed bottom-panel tabs', async () => {
    render(
      <BottomWorkspacePanel
        open
        currentProject={null}
        devices={[]}
        workspaceTarget={null}
        onRequestClose={vi.fn()}
      />
    )

    const extensionTab = screen.getByTestId('bottom-workspace-extension-tab-quality.bottom-panel')
    expect(extensionTab).toHaveAttribute('aria-selected', 'false')

    await userEvent.click(extensionTab)

    expect(extensionTab).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByTestId('bottom-workspace-extension-content-quality.bottom-panel')
    ).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('bottom-workspace-terminal-tab')).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })
})
