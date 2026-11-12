import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WeworkDshRoute } from './dshRoutes'
import { DshRouteSurface } from './DshRouteSurface'

const mocks = vi.hoisted(() => ({
  navigateTo: vi.fn(),
  workspaceTabs: null as WorkspaceTabsContextValue | null,
}))

vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useOptionalWorkspaceTabs: () => mocks.workspaceTabs,
}))

vi.mock('@/lib/navigation', () => ({
  navigateTo: mocks.navigateTo,
}))

vi.mock('./DshSlotSurface', () => ({
  DshSlotSurface: ({
    props,
  }: {
    props: { onNavigate: (path: string) => void; search: string }
  }) => (
    <button type="button" onClick={() => props.onNavigate('/sites?app_type=smart_app')}>
      打开智能工作台市场
    </button>
  ),
}))

const route = {
  id: 'sites',
  label: '应用',
  path: '/sites',
  telemetryFeature: 'apps',
} as WeworkDshRoute

function createWorkspaceTabs(activeTabId: string): WorkspaceTabsContextValue {
  return {
    tabs: [],
    activeTabId,
    activeTab: {
      id: activeTabId,
      kind: 'auxiliary',
      title: '应用',
      contentRoute: '/sites?app_type=smart_app&view=owned',
      fixed: false,
    },
    openTab: vi.fn(),
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    restoreClosedTab: vi.fn(),
    moveTab: vi.fn(),
    updateTab: vi.fn(),
    updateActiveTab: vi.fn(),
  }
}

describe('DshRouteSurface navigation', () => {
  beforeEach(() => {
    mocks.navigateTo.mockReset()
    mocks.workspaceTabs = null
  })

  test('selects the owning tab when an inactive retained surface navigates', async () => {
    const workspaceTabs = createWorkspaceTabs('task')
    mocks.workspaceTabs = workspaceTabs

    render(<DshRouteSurface route={route} search="?view=owned" workspaceTabId="applications" />)
    await userEvent.click(screen.getByRole('button', { name: '打开智能工作台市场' }))

    expect(workspaceTabs.selectTab).toHaveBeenCalledWith('applications', {
      contentRoute: '/sites?app_type=smart_app',
    })
    expect(workspaceTabs.updateActiveTab).not.toHaveBeenCalled()
  })
})
