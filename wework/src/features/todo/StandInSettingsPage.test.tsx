import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { StandInSettingsPage } from './StandInSettingsPage'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'

vi.mock('./StandInComposer', () => ({
  StandInComposer: ({ deviceControl }: { deviceControl?: ReactNode }) => (
    <div data-testid="execution-settings">{deviceControl}</div>
  ),
}))
vi.mock('./StandInRequirements', () => ({
  StandInRequirements: () => (
    <button data-testid="stand-in-requirements-open">处理要求（选填）</button>
  ),
}))

function fixture(overrides: Partial<PersonalStandInSettings> = {}) {
  let settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 0,
    autoSelect: false,
    roles: [newStandInRole('mac', 'default')],
    ...overrides,
  }
  const personalGet = vi.fn(async () => settings)
  const personalSave = vi.fn(async (_user: number, value: PersonalStandInSettings) => {
    settings = { ...value, version: settings.version + 1 }
    return settings
  })
  const props = {
    api: {} as SharedWorkspaceApi,
    projects: [
      { id: 'one', name: 'First project', project_store: 'local', tags: ['review'] },
      { id: 'two', name: 'Second project', project_store: 'local', tags: ['docs'] },
    ] as CollaborationProject[],
    devices: [{ id: 1, device_id: 'mac', name: 'Mac', status: 'online' as const }],
    userId: 7,
    services: {
      standInApi: {
        connectionProviders: vi.fn(async () => ({ items: [] })),
        personalGet,
        personalSave,
        personalAgents: vi.fn(async () => [{ id: 42, name: 'Personal reviewer' }]),
      },
      teamApi: {
        listTeams: vi.fn(async () => [{ id: 42, name: 'Personal reviewer', is_active: true }]),
      },
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    } as unknown as WorkbenchServices,
  }
  return { props, personalGet, personalSave }
}

const userSetup = () => userEvent.setup({ delay: null })

describe('Personal stand-in settings', () => {
  it('returns the created role to its parent after the first save', async () => {
    const { props, personalSave } = fixture({ roles: [] })
    const user = userSetup()
    const onSaved = vi.fn()
    render(<StandInSettingsPage {...props} initialCreate onSaved={onSaved} />)
    await user.type(await screen.findByTestId('stand-in-role-name'), 'Review role')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(personalSave).toHaveBeenCalledOnce()
    expect(onSaved.mock.calls[0][0].name).toBe('Review role')
  })

  it('confirms deleting the last scene role without saving unrelated draft edits', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    const onDeleted = vi.fn()
    render(<StandInSettingsPage {...props} initialProfileId="default" onDeleted={onDeleted} />)
    await user.click(await screen.findByTestId('stand-in-role-delete'))
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-role-delete-cancel'))
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-role-delete'))
    await user.click(screen.getByTestId('stand-in-role-delete-confirm'))
    await waitFor(() =>
      expect(personalSave).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ roles: [], version: 0 }),
        'mac'
      )
    )
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('keeps the role and shows a failed deletion instead of closing', async () => {
    const { props, personalSave } = fixture()
    personalSave.mockRejectedValue(new Error('task changed'))
    const onDeleted = vi.fn()
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProfileId="default" onDeleted={onDeleted} />)
    await user.click(await screen.findByTestId('stand-in-role-delete'))
    await user.click(screen.getByTestId('stand-in-role-delete-confirm'))
    expect(await screen.findByText('Error: task changed')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand-in-role-delete-confirm')).toBeInTheDocument()
  })

  it('preserves unsaved changes when the workbench recreates services for the same owner and device', async () => {
    const { props, personalGet } = fixture()
    const user = userSetup()
    const { rerender } = render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-auto'))
    rerender(<StandInSettingsPage {...props} services={{ ...props.services }} />)
    await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
  })

  it('keeps global selection recovery out of the project-only picker', async () => {
    const { props, personalSave } = fixture({
      selectionErrors: [
        { issueId: 'failed', title: 'Failed selection', error: 'Invalid model selection' },
      ],
    })
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    await screen.findByTestId('stand-in-project-select')
    expect(screen.queryByTestId('stand-in-selection-retry')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('retries personal selection without navigating away or changing connected projects', async () => {
    const { props, personalSave } = fixture({
      selectionErrors: [
        { issueId: 'failed', title: 'Failed selection', error: 'Invalid model selection' },
      ],
    })
    const onSaved = vi.fn()
    const user = userSetup()
    render(<StandInSettingsPage {...props} onSaved={onSaved} />)
    await user.click(await screen.findByTestId('stand-in-selection-retry'))
    await waitFor(() => expect(personalSave).toHaveBeenCalledTimes(1))
    expect(personalSave.mock.calls[0][1].roles[0].collaboration.projects).toEqual([])
    expect(personalSave.mock.calls[0][1].roles[0].collaboration.enabled).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('does not request cloud agents or show login warnings when disconnected', async () => {
    const { props } = fixture()
    render(
      <CloudConnectionContext.Provider
        value={{ isConnected: false } as CloudConnectionContextValue}
      >
        <StandInSettingsPage {...props} />
      </CloudConnectionContext.Provider>
    )
    expect(await screen.findByTestId('stand-in-agent')).toBeEnabled()
    expect(props.services.standInApi.personalAgents).not.toHaveBeenCalled()
    expect(screen.queryByText(/登录|加载个人智能体/)).not.toBeInTheDocument()
  })

  it('keeps secondary settings scoped to the selected stand-in without another picker', async () => {
    const { props } = fixture({
      roles: [newStandInRole('mac', 'first'), newStandInRole('mac', 'second')],
    })
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    await user.selectOptions(await screen.findByTestId('stand-in-project-select'), '__new')
    await user.click(screen.getByTestId('stand-in-advanced-open'))
    expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-project-select')).not.toBeInTheDocument()
    expect(screen.getByTestId('execution-settings')).toBeInTheDocument()
  })

  it('defaults to the stand-in already connected to the current project without saving on open', async () => {
    const first = newStandInRole('mac', 'first')
    const connected = {
      ...newStandInRole('mac', 'connected'),
      name: 'Connected stand-in',
      prompt: 'Project-specific instructions',
    }
    connected.collaboration = {
      ...connected.collaboration,
      enabled: true,
      allProjects: false,
      projects: [{ id: 'one', store: 'local' }],
    }
    const { props, personalSave } = fixture({ roles: [first, connected] })
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    expect(await screen.findByTestId('stand-in-project-select')).toHaveValue('connected')
    expect(screen.getByTestId('stand-in-project-summary')).toHaveTextContent(
      'Project-specific instructions'
    )
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('defaults to the first eligible personal stand-in and does not select another project’s agent', async () => {
    const other = {
      ...newStandInRole('mac', 'other'),
      agentId: 'agent',
      agentProject: { id: 'two', store: 'local' as const },
    }
    const { props, personalSave } = fixture({ roles: [other, newStandInRole('mac', 'personal')] })
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    expect(await screen.findByTestId('stand-in-project-select')).toHaveValue('personal')
    expect(screen.getByTestId('stand-in-save')).toBeEnabled()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('retries a failed agent catalog without overwriting unsaved stand-in settings', async () => {
    const { props } = fixture()
    vi.mocked(props.services.standInApi.personalAgents).mockRejectedValueOnce(new Error('offline'))
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-auto'))
    await user.click(await screen.findByTestId('stand-in-agents-retry'))
    await screen.findByRole('option', { name: 'Personal reviewer' })
    expect(screen.queryByTestId('stand-in-agents-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
  })

  it('reuses a personal stand-in without changing its instructions or enabled state', async () => {
    const existing = {
      ...newStandInRole('mac', 'review'),
      name: 'Reviewer',
      prompt: 'Review carefully',
      enabled: true,
    }
    existing.collaboration = {
      ...existing.collaboration,
      allProjects: false,
      projects: [{ id: 'two', store: 'local' }],
    }
    const { props, personalSave } = fixture({ roles: [existing] })
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    await user.selectOptions(await screen.findByTestId('stand-in-project-select'), 'review')
    expect(screen.getByTestId('stand-in-project-summary')).toHaveTextContent('Review carefully')
    expect(screen.queryByTestId('stand-in-auto')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({
            id: 'review',
            name: 'Reviewer',
            prompt: 'Review carefully',
            enabled: true,
            collaboration: expect.objectContaining({
              enabled: true,
              allProjects: false,
              projects: [
                { id: 'two', store: 'local' },
                { id: 'one', store: 'local' },
              ],
            }),
          }),
        ],
      }),
      'mac'
    )
  })

  it('creates a personally owned stand-in scoped to this project only on Save', async () => {
    const { props, personalSave } = fixture()
    const onSaved = vi.fn()
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} onSaved={onSaved} />)
    await user.selectOptions(await screen.findByTestId('stand-in-project-select'), '__new')
    expect(screen.getByTestId('stand-in-role-name')).toHaveValue('First project 分身')
    expect(screen.getByTestId('stand-in-project-select')).toHaveValue('__new')
    expect(screen.queryByTestId('execution-settings')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-auto'))
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        userId: 7,
        roles: [
          expect.objectContaining({ id: 'default' }),
          expect.objectContaining({
            name: 'First project 分身',
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
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('returns from advanced settings to the new stand-in and cancels without persisting it', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    await user.selectOptions(await screen.findByTestId('stand-in-project-select'), '__new')
    await user.click(screen.getByTestId('stand-in-advanced-open'))
    await user.click(screen.getByTestId('stand-in-back'))
    expect(screen.getByTestId('stand-in-project-select')).toHaveValue('__new')
    await user.click(screen.getByTestId('stand-in-cancel'))
    expect(screen.getByTestId('stand-in-project-select')).toHaveValue('default')
    expect(screen.queryByTestId('stand-in-role-name')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'First project 分身' })).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('excludes stand-ins tied to another project agent and discards a new draft when choosing an existing one', async () => {
    const other = {
      ...newStandInRole('mac', 'other'),
      name: 'Other project',
      agentId: 'agent',
      agentProject: { id: 'two', store: 'local' as const },
    }
    const { props, personalSave } = fixture({ roles: [newStandInRole('mac', 'default'), other] })
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    await screen.findByTestId('stand-in-project-select')
    expect(screen.queryByRole('option', { name: 'Other project' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('stand-in-project-select'), '__new')
    await user.selectOptions(screen.getByTestId('stand-in-project-select'), 'default')
    expect(screen.queryByTestId('stand-in-role-name')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave.mock.calls[0][1].roles).toHaveLength(2)
  })

  it('keeps the single-role screen simple and always exposes Add role', async () => {
    const { props, personalGet } = fixture()
    render(<StandInSettingsPage {...props} />)
    expect(await screen.findByTestId('stand-in-agent')).toHaveValue('')
    expect(screen.getByTestId('stand-in-list-configure')).toBeEnabled()
    expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-scheduling-open')).not.toBeInTheDocument()
    expect(screen.queryByTestId('execution-settings')).not.toBeInTheDocument()
    expect(personalGet).toHaveBeenCalledWith(7, 'mac')
    expect(screen.getByTestId('stand-in-sources-empty')).toBeInTheDocument()
  })

  it('creates a reusable role and reveals role selection and shared scheduling', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-list-configure'))
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写分身名称')
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-role-name'))
    await user.paste('Review')
    await user.selectOptions(screen.getByTestId('stand-in-agent'), '42')
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByTestId('stand-in-role-select')).toHaveDisplayValue('Review')
    expect(screen.getByTestId('stand-in-scheduling-open')).toHaveTextContent(
      '所有分身、所有工作来源共用'
    )
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({ id: 'default' }),
          expect.objectContaining({ name: 'Review', agentResourceId: 42, enabled: false }),
        ],
      }),
      'mac'
    )
  })

  it('connects all projects once and supports excluding individual projects', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
    await user.click(screen.getByTestId('stand-in-add-connection'))
    await user.click(screen.getByTestId('stand-in-add-projects-connection'))
    await user.click(screen.getByTestId('stand-in-source-collaboration'))
    expect(screen.getByTestId('stand-in-all-projects')).toBeChecked()
    expect(screen.getByTestId('stand-in-connect-project-one')).toBeChecked()
    expect(screen.getByTestId('stand-in-connect-project-two')).toBeChecked()
    await user.click(screen.getByTestId('stand-in-connect-project-two'))
    await user.click(screen.getByTestId('stand-in-save'))
    await screen.findByTestId('stand-in-source-summary')
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({
            collaboration: expect.objectContaining({
              enabled: true,
              allProjects: true,
              excludedProjects: [{ id: 'two', store: 'local' }],
            }),
          }),
        ],
      }),
      'mac'
    )
  })

  it('selects a project agent and connects only its owning project automatically', async () => {
    const { props, personalSave } = fixture()
    props.api = {
      agents: {
        list: vi.fn(async (id: string) =>
          id === 'one'
            ? [{ id: 'reviewer', name: 'Project reviewer', runtime: 'codex', status: 'active' }]
            : []
        ),
      },
    } as unknown as SharedWorkspaceApi
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    const option = await screen.findByRole('option', { name: 'Project reviewer · First project' })
    await user.selectOptions(screen.getByTestId('stand-in-agent'), option)
    expect(screen.getByTestId('stand-in-project-agent-scope')).toHaveTextContent('First project')
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({
            agentId: 'reviewer',
            agentResourceId: null,
            agentProject: { id: 'one', store: 'local' },
            collaboration: expect.objectContaining({
              enabled: true,
              allProjects: false,
              projects: [{ id: 'one', store: 'local' }],
              excludedProjects: [],
            }),
          }),
        ],
      }),
      'mac'
    )
    await user.click(screen.getByTestId('stand-in-connections-open'))
    expect(screen.queryByTestId('stand-in-all-projects')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-connect-project-two')).not.toBeInTheDocument()
  })

  it('keeps the newly selected device when returning from execution settings', async () => {
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
    props.devices.push({ id: 2, device_id: 'remote', name: 'Remote', status: 'online' })
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-advanced-open'))
    await user.selectOptions(screen.getByTestId('stand-in-device'), 'remote')
    await waitFor(() => expect(screen.getByTestId('stand-in-device')).toHaveValue('remote'))
    await user.click(screen.getByTestId('stand-in-back'))
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        executionDeviceId: 'remote',
        roles: [expect.objectContaining({ executionDeviceId: 'remote' })],
      }),
      'remote'
    )
  })

  it('discards an invalid new role without leaving its validation error on the main page', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-list-configure'))
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写分身名称')
    expect(screen.queryByTestId('stand-in-reload')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-cancel'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('keeps unnamed migrated roles distinct from their projects and allows saving', async () => {
    const first = { ...newStandInRole('mac', 'first'), version: 1 }
    const second = { ...newStandInRole('mac', 'second'), version: 1 }
    first.collaboration = {
      ...first.collaboration,
      allProjects: false,
      projects: [{ id: 'one', store: 'local' }],
    }
    second.collaboration = {
      ...second.collaboration,
      allProjects: false,
      projects: [{ id: 'two', store: 'local' }],
    }
    const { props, personalSave } = fixture({ roles: [first, second] })
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    expect(await screen.findByRole('option', { name: '默认分身' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '默认分身 2' })).toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-auto'))
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(personalSave).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('discards connection drafts on Back and does not change saved configuration', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
    await user.click(screen.getByTestId('stand-in-add-connection'))
    await user.click(screen.getByTestId('stand-in-add-projects-connection'))
    await user.click(screen.getByTestId('stand-in-source-collaboration'))
    await user.click(screen.getByTestId('stand-in-back'))
    expect(screen.getByTestId('stand-in-sources-empty')).toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('applies automatic handling only after Save and preserves a failed-save draft', async () => {
    const { props, personalSave } = fixture()
    personalSave.mockRejectedValueOnce(new Error('version_conflict'))
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-auto'))
    expect(personalSave).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand-in-pending-save')).toHaveTextContent('开启并保存后')
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('version_conflict')
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
  })

  it('stores shared AI selection and deterministic ordering without changing role sources', async () => {
    const first = { ...newStandInRole('mac', 'development'), name: 'Development' }
    const second = { ...newStandInRole('mac', 'review'), name: 'Review' }
    const { props, personalSave } = fixture({ roles: [first, second] })
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-scheduling-open'))
    await user.click(screen.getByTestId('stand-in-auto-select'))
    await user.click(screen.getByTestId('stand-in-order-up-review'))
    await user.click(screen.getByTestId('stand-in-save'))
    await screen.findByTestId('stand-in-scheduling-open')
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ autoSelect: true, roles: [second, first] }),
      'mac'
    )
  })

  it('focuses the current project through the project entry without creating project-owned settings', async () => {
    const { props, personalGet } = fixture()
    render(<StandInSettingsPage {...props} initialProject={props.projects[1]} />)
    expect(await screen.findByTestId('stand-in-project-setup')).toBeInTheDocument()
    expect(personalGet).toHaveBeenCalledExactlyOnceWith(7, 'mac')
    expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
  })

  it('requires an explicit discard action before closing unsaved personal settings', async () => {
    const { props } = fixture()
    const onCancel = vi.fn()
    const user = userSetup()
    render(<StandInSettingsPage {...props} onCancel={onCancel} />)
    await user.click(await screen.findByTestId('stand-in-auto'))
    await user.click(screen.getByTestId('stand-in-close'))
    expect(onCancel).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-discard'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('shows load failures and supports explicit recovery', async () => {
    const { props, personalGet } = fixture()
    personalGet.mockRejectedValueOnce(new Error('Executor offline'))
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Executor offline')
    await user.click(screen.getByTestId('stand-in-reload'))
    expect(await screen.findByTestId('stand-in-agent')).toBeInTheDocument()
    await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))
  })
})
