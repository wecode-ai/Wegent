import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { StandInSettingsPage } from './StandInSettingsPage'

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
vi.mock('@/features/automations/AutomationsPage', () => ({
  AutomationsPage: () => <div data-testid="calendar-editor-fixture" />,
}))

/** Provide device-owned settings with versioned saves and traps for obsolete agent lookups. */
function fixture(overrides: Partial<PersonalStandInSettings> = {}) {
  let settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 0,
    roles: [newStandInRole('mac', 'default')],
    ...overrides,
  }
  const personalGet = vi.fn(async () => settings)
  const personalSave = vi.fn(async (_user: number, value: PersonalStandInSettings) => {
    settings = { ...value, version: settings.version + 1 }
    return settings
  })
  const personalAgents = vi.fn(async () => [{ id: 42, name: 'Personal reviewer' }])
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
        personalAgents,
      },
      agentResourceApi: {
        getAgent: vi.fn(async () => {
          throw new Error('Unexpected agent lookup')
        }),
      },
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    } as unknown as WorkbenchServices,
  }
  return { props, personalGet, personalSave, personalAgents }
}

const userSetup = () => userEvent.setup({ delay: null })

describe('Personal stand-in settings', () => {
  it('saves the role device while keeping draft text and leaving old workspace settings at the source', async () => {
    const role = {
      ...newStandInRole('mac', 'review'),
      name: 'Review',
      model: { runtime: 'codex' as const, provider: 'openai', model_id: 'old-model' },
      modelOptions: { effort: 'high' },
      workspace: {
        projectKey: 'repo',
        workspacePath: '/old/repo',
        executionMode: 'current_workspace' as const,
      },
    }
    const { props } = fixture({ roles: [role] })
    props.devices.push({ id: 2, device_id: 'remote', name: 'Remote', status: 'online' })
    const api = props.services.standInApi as StandInExecutorApi
    const source = await api.personalGet(7, 'mac')
    const profiles = new Map<string, PersonalStandInSettings>([
      ['mac', source],
      ['remote', { userId: 7, executionDeviceId: 'remote', version: 0, roles: [] }],
    ])
    api.personalGet = vi.fn(async (_user, device) => structuredClone(profiles.get(device!)!))
    api.personalSave = vi.fn(async (_user, value, device) => {
      const saved = structuredClone({ ...value, version: value.version + 1 })
      profiles.set(device!, saved)
      return saved
    })
    const onSaved = vi.fn()
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProfileId="review" onSaved={onSaved} />)
    await user.type(await screen.findByTestId('stand-in-role-name'), ' revised')
    expect(screen.getByTestId('stand-in-role-device')).toHaveAccessibleName('执行设备')
    await user.selectOptions(screen.getByTestId('stand-in-role-device'), 'remote')
    expect(screen.getByTestId('stand-in-role-name')).toHaveValue('Review revised')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(profiles.get('remote')!.roles[0]).toMatchObject({
      id: 'review',
      name: 'Review revised',
      executionDeviceId: 'remote',
    })
    expect(profiles.get('remote')!.roles[0].model).toBeUndefined()
    expect(profiles.get('remote')!.roles[0].modelOptions).toBeUndefined()
    expect(profiles.get('remote')!.roles[0].workspace).toBeUndefined()
    expect(profiles.get('mac')!.roles[0]).toMatchObject({
      ...role,
      executionDeviceId: 'remote',
    })
  })

  it('provides clickable paths from role source details back to connections and settings', async () => {
    const { props } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
    await user.click(await screen.findByTestId('stand-in-add-projects-connection'))
    expect(await screen.findByTestId('stand-in-path-source')).toHaveTextContent('协作项目')
    await user.click(screen.getByTestId('stand-in-path-connections'))
    expect(screen.queryByTestId('stand-in-path-source')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-path-settings'))
    expect(screen.getByTestId('stand-in-connections-open')).toBeVisible()
  })
  it('keeps connection settings save available in a role calendar and consumes the initial deep link once', async () => {
    const { props } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProfileId="default" initialCalendar />)
    await screen.findByTestId('stand-in-calendar-connection')
    expect(screen.getByTestId('stand-in-save')).toBeVisible()
    expect(screen.getByTestId('stand-in-settings')).not.toHaveClass('max-w-xl')
    await user.click(screen.getByTestId('stand-in-connections-back'))
    await user.click(screen.getByTestId('stand-in-back'))
    await user.click(screen.getByTestId('stand-in-connections-open'))
    expect(screen.getByTestId('stand-in-time-connections')).toBeVisible()
    expect(screen.queryByTestId('stand-in-calendar-connection')).not.toBeInTheDocument()
  })
  it('does not load or display agents in independent stand-in settings', async () => {
    const { props, personalAgents } = fixture()
    const list = vi.fn(async () => [])
    props.api = { agents: { list } } as unknown as SharedWorkspaceApi
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await screen.findByTestId('stand-in-role-name')
    expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
    expect(personalAgents).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-advanced-open'))
    expect(screen.getByTestId('execution-settings')).toBeVisible()
    expect(props.services.agentResourceApi!.getAgent).not.toHaveBeenCalled()
  })

  it('keeps project names visible on another device without offering local projects to connect', async () => {
    const role = newStandInRole('remote', 'review')
    role.collaboration = {
      ...role.collaboration,
      enabled: true,
      allProjects: false,
      projects: [
        { id: 'one', store: 'local' },
        { id: 'one', store: 'cloud' },
      ],
    }
    const { props } = fixture({ executionDeviceId: 'remote', roles: [role] })
    props.projects.push({
      id: 'one',
      name: 'Cloud project',
      project_store: 'backend',
    } as CollaborationProject)
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialDeviceId="remote" />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
    expect(screen.getByTestId('stand-in-connection-project-local-one')).toHaveTextContent(
      'First project'
    )
    expect(screen.getByTestId('stand-in-connection-project-cloud-one')).toHaveTextContent(
      'Cloud project'
    )
    await user.click(screen.getByTestId('stand-in-connection-project-local-one'))
    expect(screen.getByRole('checkbox', { name: 'First project' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'Second project' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Cloud project' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'First project' }))
    expect(screen.queryByRole('checkbox', { name: 'First project' })).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-connections-back'))
    expect(screen.queryByTestId('stand-in-connection-project-local-one')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-connection-project-cloud-one')).toHaveTextContent(
      'Cloud project'
    )
  })

  it('keeps remote all-project scope without offering projects owned by this computer', async () => {
    const role = newStandInRole('remote', 'review')
    role.collaboration.enabled = true
    role.collaboration.allProjects = false
    const { props, personalSave } = fixture({ executionDeviceId: 'remote', roles: [role] })
    props.projects.push({
      id: 'cloud',
      name: 'Cloud project',
      project_store: 'backend',
    } as CollaborationProject)
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialDeviceId="remote" />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
    await user.click(screen.getByTestId('stand-in-add-projects-connection'))
    expect(screen.queryByRole('checkbox', { name: 'First project' })).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-all-projects'))
    expect(screen.getByRole('checkbox', { name: 'Cloud project' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'First project' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Second project' })).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({
            collaboration: expect.objectContaining({ allProjects: true, projects: [] }),
          }),
        ],
      }),
      'remote'
    )
  })

  it('waits for empty-role settings before creating and saving the first role', async () => {
    const { props, personalGet, personalSave } = fixture({ roles: [] })
    const settings = await personalGet()
    let resolveSettings!: (value: PersonalStandInSettings) => void
    personalGet.mockReturnValueOnce(
      new Promise<PersonalStandInSettings>(resolve => {
        resolveSettings = resolve
      })
    )
    const user = userSetup()
    const onSaved = vi.fn()
    render(<StandInSettingsPage {...props} initialCreate onSaved={onSaved} />)
    await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('stand-in-role-name')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
    await act(async () => resolveSettings(settings))
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
    expect(
      await screen.findByText('助理设置未保存。请保留当前修改，检查执行设备连接后重新保存。')
    ).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand-in-role-delete-confirm')).toBeInTheDocument()
  })

  it('preserves unsaved changes when the workbench recreates services for the same owner and device', async () => {
    const { props, personalGet } = fixture()
    const user = userSetup()
    const { rerender } = render(<StandInSettingsPage {...props} />)
    await user.type(await screen.findByTestId('stand-in-role-name'), ' changed')
    rerender(<StandInSettingsPage {...props} services={{ ...props.services }} />)
    await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('stand-in-role-name')).toHaveValue(' changed')
  })

  it('keeps local role settings usable without embedding IM connection controls', async () => {
    const { props, personalAgents } = fixture()
    render(
      <CloudConnectionContext.Provider
        value={{ isConnected: false } as CloudConnectionContextValue}
      >
        <StandInSettingsPage {...props} />
      </CloudConnectionContext.Provider>
    )
    expect(await screen.findByTestId('stand-in-role-name')).toBeEnabled()
    expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
    expect(personalAgents).not.toHaveBeenCalled()
    expect(screen.queryByText(/加载个人智能体/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/登录/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-im-channels')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-im-connections')).not.toBeInTheDocument()
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

  it('defaults to the first independent stand-in without saving on open', async () => {
    const { props, personalSave } = fixture({
      roles: [newStandInRole('mac', 'first'), newStandInRole('mac', 'second')],
    })
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    expect(await screen.findByTestId('stand-in-project-select')).toHaveValue('first')
    expect(screen.getByTestId('stand-in-save')).toBeEnabled()
    expect(personalSave).not.toHaveBeenCalled()
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
    expect(screen.getByTestId('stand-in-role-name')).toHaveValue('First project 助理')
    expect(screen.getByTestId('stand-in-project-select')).toHaveValue('__new')
    expect(screen.queryByTestId('execution-settings')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stand-in-auto')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        userId: 7,
        roles: [
          expect.objectContaining({ id: 'default' }),
          expect.objectContaining({
            name: 'First project 助理',
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
    expect(screen.queryByRole('option', { name: 'First project 助理' })).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('offers independent stand-ins and discards a new draft when choosing an existing one', async () => {
    const other = {
      ...newStandInRole('mac', 'other'),
      name: 'Other project',
    }
    const { props, personalSave } = fixture({ roles: [newStandInRole('mac', 'default'), other] })
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    await screen.findByTestId('stand-in-project-select')
    expect(screen.getByRole('option', { name: 'Other project' })).toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('stand-in-project-select'), '__new')
    await user.selectOptions(screen.getByTestId('stand-in-project-select'), 'default')
    expect(screen.queryByTestId('stand-in-role-name')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave.mock.calls[0][1].roles).toHaveLength(2)
  })

  it('creates a reusable role and keeps its name editable without selection settings', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-list-configure'))
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写助理名称')
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-role-name'))
    await user.paste('Review')
    expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    await screen.findByTestId('stand-in-saved')
    expect(screen.getByTestId('stand-in-role-name')).toHaveValue('Review')
    expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-scheduling-open')).not.toBeInTheDocument()
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({ id: 'default' }),
          expect.objectContaining({ name: 'Review', enabled: true }),
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
    await user.click(screen.getByTestId('stand-in-add-projects-connection'))
    await user.click(screen.getByTestId('stand-in-source-collaboration'))
    expect(screen.getByTestId('stand-in-all-projects')).toBeChecked()
    expect(screen.getByTestId('stand-in-connect-project-one')).toBeChecked()
    expect(screen.getByTestId('stand-in-connect-project-two')).toBeChecked()
    await user.click(screen.getByTestId('stand-in-connect-project-two'))
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    await screen.findByTestId('stand-in-source-summary')
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({
            enabled: true,
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

  it('clears a paused role draft when an unsaved source activation is undone', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    const onCancel = vi.fn()
    render(<StandInSettingsPage {...props} onCancel={onCancel} />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
    await user.click(screen.getByTestId('stand-in-add-projects-connection'))
    const source = screen.getByTestId('stand-in-source-collaboration')
    await user.click(source)
    await user.click(screen.getByTestId('stand-in-close'))
    expect(screen.getByTestId('stand-in-discard')).toBeVisible()
    await user.click(screen.getByTestId('stand-in-keep-editing'))
    await user.click(source)
    await user.click(screen.getByTestId('stand-in-close'))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('stand-in-discard')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('creates an independent project stand-in connected only to that project', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} initialProject={props.projects[0]} />)
    await user.selectOptions(await screen.findByTestId('stand-in-project-select'), '__new')
    expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    const added = personalSave.mock.calls[0][1].roles.at(-1)!
    expect(added.collaboration).toMatchObject({
      enabled: true,
      allProjects: false,
      projects: [{ id: 'one', store: 'local' }],
    })
    expect(added).not.toHaveProperty('agentId')
    expect(added).not.toHaveProperty('agentResourceId')
    expect(added).not.toHaveProperty('agentProject')
  })

  it('discards an invalid new role without leaving its validation error on the main page', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-list-configure'))
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写助理名称')
    expect(screen.queryByTestId('stand-in-reload')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-cancel'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it.each([
    ['first', '默认助理'],
    ['second', '默认助理 2'],
  ])('keeps the migrated role %s identifiable and allows saving', async (id, name) => {
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
    render(<StandInSettingsPage {...props} initialProfileId={id} />)
    expect(await screen.findByRole('textbox', { name: '助理名称' })).toHaveAttribute(
      'placeholder',
      name
    )
    expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('stand-in-role-name'), ' changed')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(personalSave).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renames only the selected role, preserves a failed draft, and reloads the saved name', async () => {
    const first = { ...newStandInRole('mac', 'development'), name: 'Development' }
    const second = { ...newStandInRole('mac', 'review'), name: 'Review', prompt: 'Check risks' }
    const { props, personalSave } = fixture({ roles: [first, second] })
    personalSave.mockRejectedValueOnce(new Error('version_conflict'))
    const user = userSetup()
    const { unmount } = render(<StandInSettingsPage {...props} initialProfileId="review" />)
    const name = await screen.findByRole('textbox', { name: '助理名称' })
    expect(name).toHaveValue('Review')
    expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
    await user.clear(name)
    await user.type(name, '代码审查')
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '助理设置已在其他位置更新，请刷新后重新修改。'
    )
    expect(name).toHaveValue('代码审查')
    await user.click(screen.getByTestId('stand-in-save'))
    await screen.findByTestId('stand-in-saved')
    expect(personalSave).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ roles: [first, { ...second, name: '代码审查' }] }),
      'mac'
    )
    unmount()
    render(<StandInSettingsPage {...props} initialProfileId="review" />)
    expect(await screen.findByRole('textbox', { name: '助理名称' })).toHaveValue('代码审查')
  })

  it('discards connection drafts on Back and does not change saved configuration', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
    await user.click(screen.getByTestId('stand-in-add-projects-connection'))
    await user.click(screen.getByTestId('stand-in-source-collaboration'))
    expect(screen.queryByText('返回连接')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('stand-in-connections-back')).toHaveLength(1)
    await user.click(screen.getByTestId('stand-in-connections-back'))
    await user.click(screen.getByTestId('stand-in-back'))
    expect(screen.getByTestId('stand-in-sources-empty')).toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  })

  it('applies instructions only after Save and preserves a failed-save draft', async () => {
    const { props, personalSave } = fixture()
    personalSave.mockRejectedValueOnce(new Error('version_conflict'))
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.type(await screen.findByTestId('stand-in-role-name'), ' changed')
    expect(personalSave).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stand-in-auto')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '助理设置已在其他位置更新，请刷新后重新修改。'
    )
    expect(screen.getByTestId('stand-in-role-name')).toHaveValue(' changed')
  })

  it('saves connected roles without selection or priority settings', async () => {
    const first = { ...newStandInRole('mac', 'development'), name: 'Development' }
    const second = { ...newStandInRole('mac', 'review'), name: 'Review' }
    const { props, personalSave } = fixture({ roles: [first, second] })
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await screen.findByTestId('stand-in-role-name')
    expect(screen.queryByTestId('stand-in-scheduling-open')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-auto-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-selection-retry')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ roles: [first, second] }),
      'mac'
    )
    expect(personalSave.mock.calls[0][1]).not.toHaveProperty('autoSelect')
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
    await user.type(await screen.findByTestId('stand-in-role-name'), '未保存的名称')
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
    expect(await screen.findByRole('alert')).toHaveTextContent('执行设备离线，请连接设备后重试。')
    await user.click(screen.getByTestId('stand-in-reload'))
    expect(await screen.findByTestId('stand-in-role-name')).toBeInTheDocument()
    await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))
  })
})

it('preserves independent source connections and the draft after a save failure', async () => {
  const role = newStandInRole('mac', 'review')
  role.name = 'Review'
  role.connections = [
    {
      providerId: 'example',
      id: 'group',
      name: 'Work group',
      kind: 'group',
      profile: 'work',
      policy: { automatic: true, askBeforeAct: true },
    },
  ]
  const { props, personalSave } = fixture({ roles: [role] })
  personalSave.mockRejectedValueOnce(new Error('offline'))
  const user = userSetup()
  render(<StandInSettingsPage {...props} />)
  await user.click(await screen.findByTestId('stand-in-save'))
  expect(await screen.findByRole('alert')).toHaveTextContent('助理设置未保存')
  expect(screen.getByTestId('stand-in-role-name')).toHaveValue('Review')
  expect(personalSave.mock.calls[0][1].roles[0].connections).toEqual(role.connections)
  await user.click(screen.getByTestId('stand-in-save'))
  await screen.findByTestId('stand-in-saved')
  expect(personalSave.mock.calls[1][1].roles[0].connections).toEqual(role.connections)
})
