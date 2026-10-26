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
  let settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 1,
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
  const personalSave = vi.fn(async (_user: number, value: PersonalStandInSettings) => {
    settings = { ...value, version: 2 }
    publishPersonalStandIn(settings)
    return settings
  })
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
  it('opens stand-in selection for the current project, including for viewers', async () => {
    const { props, personalGet } = fixture()
    const onOpenPersonalSettings = vi.fn()
    const user = userEvent.setup()
    render(<StandInPopover {...props} onOpenPersonalSettings={onOpenPersonalSettings} />)
    await user.click(screen.getByTestId('stand-in-open'))
    expect(await screen.findByTestId('stand-in-project-select')).toHaveValue('default')
    expect(screen.getByTestId('stand-in-save')).toBeEnabled()
    expect(screen.queryByTestId('stand-in-connections')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('stand-in-project-select'), 'default')
    expect(screen.getByTestId('stand-in-project-summary')).toBeInTheDocument()
    expect(personalGet).toHaveBeenCalledWith(7, 'mac')
    expect(props.api.projects.list).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-personal-settings-link'))
    expect(onOpenPersonalSettings).toHaveBeenCalledWith('default', 'mac')
    expect(screen.queryByTestId('stand-in-dialog')).not.toBeInTheDocument()
  })

  it('enables the selected stand-in, connects the project and updates the badge after explicit save', async () => {
    const { props, personalSave } = fixture()
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(<StandInPopover {...props} onSaved={onSaved} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.selectOptions(await screen.findByTestId('stand-in-project-select'), 'default')
    expect(screen.getByTestId('stand-in-save')).toHaveTextContent('开启并用于此项目')
    expect(screen.getByTestId('stand-in-project-enable-help')).toHaveTextContent('其他项目')
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(screen.queryByTestId('stand-in-dialog')).not.toBeInTheDocument())
    expect(onSaved).toHaveBeenCalledOnce()
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({
            enabled: true,
            collaboration: expect.objectContaining({
              enabled: true,
              allProjects: false,
              projects: [{ id: 'one', store: 'local' }],
            }),
          }),
        ],
      }),
      'mac'
    )
    expect(screen.getByTestId('stand-in-enabled')).toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-open'))
    expect(await screen.findByTestId('stand-in-project-summary')).toHaveTextContent('已开启')
    expect(screen.getByTestId('stand-in-save')).toHaveTextContent('停用于此项目')
    expect(screen.queryByRole('button', { name: '开启并用于此项目' })).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(screen.queryByTestId('stand-in-dialog')).not.toBeInTheDocument())
    expect(personalSave.mock.calls[1][1].roles[0].enabled).toBe(true)
    expect(personalSave.mock.calls[1][1].roles[0].collaboration.projects).toEqual([])
    expect(screen.queryByTestId('stand-in-enabled')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-open'))
    expect(await screen.findByTestId('stand-in-project-summary')).toHaveTextContent('未开启')
    expect(screen.getByTestId('stand-in-save')).toHaveTextContent('开启并用于此项目')
    expect(screen.queryByRole('button', { name: '停用于此项目' })).not.toBeInTheDocument()
  })

  it('requires explicit discard when Escape closes a dirty personal configuration', async () => {
    const { props, personalSave } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.selectOptions(await screen.findByTestId('stand-in-project-select'), '__new')
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

  it('routes personal settings to the explicitly requested device without changing project connections', async () => {
    const { props, personalSave, personalGet, settings } = fixture()
    personalGet.mockImplementation(async (...args: unknown[]) => ({
      ...settings,
      executionDeviceId: String(args[1]),
    }))
    const onOpenPersonalSettings = vi.fn()
    const user = userEvent.setup()
    render(
      <StandInPopover
        {...props}
        initialDeviceId="remote"
        onOpenPersonalSettings={onOpenPersonalSettings}
      />
    )
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-personal-settings-link'))
    expect(onOpenPersonalSettings).toHaveBeenCalledWith('default', 'remote')
    expect(personalSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stand-in-dialog')).not.toBeInTheDocument()
  })

  it('does not expose an unusable project entry without personal services or identity', () => {
    const { props } = fixture()
    const { rerender } = render(<StandInPopover {...props} services={undefined} />)
    expect(screen.queryByTestId('stand-in-open')).not.toBeInTheDocument()
    rerender(<StandInPopover {...props} userId={undefined} />)
    expect(screen.queryByTestId('stand-in-open')).not.toBeInTheDocument()
  })
})
