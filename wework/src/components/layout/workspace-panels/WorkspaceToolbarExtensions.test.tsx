import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '../DesktopTopBar'
import { WorkspaceToolbarExtensions } from './WorkspaceToolbarExtensions'

const { menuActionsMock, slotSurfaceMock } = vi.hoisted(() => ({
  menuActionsMock: vi.fn(),
  slotSurfaceMock: vi.fn(),
}))

vi.mock('@/features/dsh-runtime/DshMenuActions', () => ({
  DshMenuActions: (props: Record<string, unknown>) => {
    menuActionsMock(props)
    return <div data-testid="mock-dsh-menu-actions" />
  },
}))

vi.mock('@/features/dsh-runtime/DshContributionSlotSurface', () => ({
  DshContributionSlotSurface: (props: Record<string, unknown>) => {
    slotSurfaceMock(props)
    return <div data-testid="mock-dsh-slot-surface" />
  },
}))

describe('WorkspaceToolbarExtensions', () => {
  test('renders the native titlebar menu and slot with workspace context', () => {
    const currentProject = {
      id: 7,
      name: 'Wegent',
      config: {},
      tasks: [],
    }
    const environmentInfo = {
      additions: '+3',
      deletions: '-1',
      executionTarget: 'local' as const,
    }
    const workspaceTarget = {
      kind: 'project' as const,
      projectId: 7,
      path: '/workspace/wegent',
    }

    render(
      <WorkspaceToolbarExtensions
        currentProject={currentProject}
        environmentInfo={environmentInfo}
        workspaceTarget={workspaceTarget}
      />
    )

    expect(screen.getByTestId('workspace-toolbar-extension-actions')).toBeInTheDocument()
    expect(screen.getByTestId('mock-dsh-menu-actions')).toBeInTheDocument()
    expect(screen.getByTestId('mock-dsh-slot-surface')).toBeInTheDocument()
    expect(menuActionsMock).toHaveBeenCalledWith({
      buttonClassName: DESKTOP_TOP_BAR_BUTTON_CLASS,
      location: 'workspace.toolbar',
    })
    expect(slotSurfaceMock).toHaveBeenCalledWith({
      attachedClassName: 'contents',
      props: { currentProject, environmentInfo, workspaceTarget },
      slot: WEWORK_DSH_SLOTS.workspaceToolbarAction,
    })
  })
})
