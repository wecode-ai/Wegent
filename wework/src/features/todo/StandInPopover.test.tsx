import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import {
  newStandInRole,
  publishPersonalStandIn,
  type PersonalStandInSettings,
} from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { StandInPopover } from './StandInPopover'

vi.mock('./StandInComposer', () => ({
  StandInComposer: ({ deviceControl }: { deviceControl?: ReactNode }) => <div>{deviceControl}</div>,
}))
vi.mock('./StandInRequirements', () => ({ StandInRequirements: () => <div /> }))

function fixture() {
  const settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 1,
    autoSelect: false,
    roles: [newStandInRole('mac', 'default')],
  }
  const project = {
    id: 'one',
    name: 'Current project',
    project_store: 'local',
    access_role: 'Viewer',
    tags: [],
  } as unknown as CollaborationProject
  const personalGet = vi.fn(async () => settings)
  const personalSave = vi.fn(async (_user: number, value: PersonalStandInSettings) => ({
    ...value,
    version: 2,
  }))
  const props = {
    api: { projects: { list: vi.fn(async () => [project]) } } as unknown as SharedWorkspaceApi,
    project,
    userId: 7,
    services: {
      standInApi: { personalGet, personalSave, personalAgents: vi.fn(async () => []) },
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    } as unknown as WorkbenchServices,
  }
  return { props, settings, personalGet, personalSave }
}

describe('Project personal stand-in entry', () => {
  it('opens the shared personal connection page for the current project, including for viewers', async () => {
    const { props, personalGet } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    expect(await screen.findByTestId('stand-in-connections')).toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-source-collaboration'))
    expect(screen.getByTestId('stand-in-connect-project-one')).toBeInTheDocument()
    expect(personalGet).toHaveBeenCalledWith(7, 'mac')
    expect(props.api.projects.list).toHaveBeenCalledOnce()
    await user.click(screen.getByTestId('stand-in-back'))
    expect(await screen.findByTestId('stand-in-agent')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-list-configure')).toBeEnabled()
  })

  it('keeps edits until explicit save and closes the modal after a successful connection save', async () => {
    const { props, personalSave } = fixture()
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(<StandInPopover {...props} onSaved={onSaved} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-source-collaboration'))
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    await screen.findByTestId('stand-in-agent')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(screen.queryByTestId('stand-in-dialog')).not.toBeInTheDocument())
    expect(onSaved).toHaveBeenCalledOnce()
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({ collaboration: expect.objectContaining({ enabled: true }) }),
        ],
      })
    )
  })

  it('requires explicit discard when Escape closes a dirty personal configuration', async () => {
    const { props, personalSave } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-back'))
    await user.click(screen.getByTestId('stand-in-auto'))
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('stand-in-dialog')).toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-discard'))
    expect(screen.queryByTestId('stand-in-dialog')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('updates the project badge only for the current personal owner and connected project', async () => {
    const { props, settings } = fixture()
    render(<StandInPopover {...props} />)
    await waitFor(() => expect(props.services.standInApi.personalGet).toHaveBeenCalled())
    const active = {
      ...settings,
      roles: [
        {
          ...settings.roles[0],
          enabled: true,
          collaboration: { ...settings.roles[0].collaboration, enabled: true },
        },
      ],
    }
    act(() => publishPersonalStandIn({ ...active, userId: 8 }))
    expect(screen.queryByTestId('stand-in-enabled')).not.toBeInTheDocument()
    act(() => publishPersonalStandIn({ ...active, executionDeviceId: 'another-device' }))
    expect(screen.queryByTestId('stand-in-enabled')).not.toBeInTheDocument()
    act(() => publishPersonalStandIn(active))
    expect(screen.getByTestId('stand-in-enabled')).toBeInTheDocument()
    act(() =>
      publishPersonalStandIn({
        ...active,
        roles: [
          {
            ...active.roles[0],
            collaboration: {
              ...active.roles[0].collaboration,
              excludedProjects: [{ id: 'one', store: 'local' }],
            },
          },
        ],
      })
    )
    expect(screen.queryByTestId('stand-in-enabled')).not.toBeInTheDocument()
  })

  it('reopens the device whose personal settings were explicitly saved', async () => {
    const { props, personalGet, personalSave } = fixture()
    personalGet.mockImplementation(async (...args: unknown[]) => {
      const device = String(args[1])
      return {
        userId: 7,
        executionDeviceId: device,
        version: 0,
        autoSelect: false,
        roles: [newStandInRole(device, 'default')],
      }
    })
    const user = userEvent.setup()
    render(
      <StandInPopover
        {...props}
        devices={[{ id: 2, device_id: 'remote', name: 'Remote', status: 'online' }]}
      />
    )
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-back'))
    await user.click(screen.getByTestId('stand-in-advanced-open'))
    await user.selectOptions(screen.getByTestId('stand-in-device'), 'remote')
    await waitFor(() => expect(screen.getByTestId('stand-in-device')).toHaveValue('remote'))
    await user.click(screen.getByTestId('stand-in-back'))
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(screen.queryByTestId('stand-in-dialog')).not.toBeInTheDocument())
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ executionDeviceId: 'remote' })
    )
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-back'))
    await user.click(screen.getByTestId('stand-in-advanced-open'))
    expect(screen.getByTestId('stand-in-device')).toHaveValue('remote')
  })

  it('does not expose an unusable project entry without personal services or identity', () => {
    const { props } = fixture()
    const { rerender } = render(<StandInPopover {...props} services={undefined} />)
    expect(screen.queryByTestId('stand-in-open')).not.toBeInTheDocument()
    rerender(<StandInPopover {...props} userId={undefined} />)
    expect(screen.queryByTestId('stand-in-open')).not.toBeInTheDocument()
  })
})
