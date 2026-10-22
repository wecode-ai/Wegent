import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { StandInSettingsPage } from './StandInSettingsPage'

vi.mock('./StandInPopover', () => ({
  StandInPopover: ({
    project,
    initialDeviceId,
    onSaved,
  }: {
    project: CollaborationProject
    initialDeviceId: string
    onSaved(settings: WorkspaceStandInSettings, action?: 'settings' | 'automatic'): void
  }) => (
    <>
      <button
        data-testid="shared-stand-in-editor"
        data-project={project.id}
        data-device={initialDeviceId}
        onClick={() => onSaved({} as WorkspaceStandInSettings, 'settings')}
      >
        Save
      </button>
      <button
        data-testid="shared-stand-in-toggle"
        onClick={() => onSaved({} as WorkspaceStandInSettings, 'automatic')}
      >
        Toggle automatic handling
      </button>
    </>
  ),
}))

function fixture(rows: Record<string, unknown>[] = []) {
  const list = vi.fn(async () => rows)
  return {
    list,
    props: {
      api: {} as SharedWorkspaceApi,
      projects: [
        { id: 'project', name: 'Project', project_store: 'local' },
      ] as CollaborationProject[],
      devices: [{ id: 1, device_id: 'mac', name: 'Mac', status: 'online' as const }],
      userId: 7,
      services: {
        standInApi: { list },
        getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
      } as unknown as WorkbenchServices,
    },
  }
}

describe('Stand-in list page', () => {
  it('shows an empty list before the user opens configuration', async () => {
    const { props, list } = fixture()
    render(<StandInSettingsPage {...props} />)
    expect(await screen.findByTestId('stand-in-list-empty')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('shared-stand-in-editor')).not.toBeInTheDocument()
    expect(list).toHaveBeenCalledExactlyOnceWith(7, 'mac', true)
    await userEvent.click(screen.getByTestId('stand-in-list-configure'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('shared-stand-in-editor')).toHaveAttribute('data-project', 'project')
  })

  it('refreshes the list without closing the editor after an automatic handling toggle', async () => {
    const { props, list } = fixture()
    render(<StandInSettingsPage {...props} />)
    await screen.findByTestId('stand-in-list-empty')
    await userEvent.click(screen.getByTestId('stand-in-list-configure'))
    await userEvent.click(screen.getByTestId('shared-stand-in-toggle'))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('lists project, device, workspace and automatic state, and edits that exact configuration', async () => {
    const { props, list } = fixture([
      {
        projectId: 'project',
        projectStore: 'local',
        userId: 7,
        executionDeviceId: 'mac',
        id: 'default',
        enabled: false,
        name: 'Reviewer',
        workspace: { workspacePath: '/repo' },
      },
    ])
    render(<StandInSettingsPage {...props} />)
    const row = await screen.findByTestId('stand-in-list-row-project')
    expect(row).toHaveTextContent('Reviewer')
    expect(row).toHaveTextContent('Project')
    expect(row).toHaveTextContent('Mac')
    expect(row).toHaveTextContent('/repo')
    expect(row).toHaveTextContent('未开启')
    await userEvent.click(screen.getByTestId('stand-in-list-edit-project'))
    expect(screen.getByTestId('shared-stand-in-editor')).toHaveAttribute('data-device', 'mac')
    await userEvent.click(screen.getByTestId('shared-stand-in-editor'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(list).toHaveBeenCalledTimes(2)
  })
})
