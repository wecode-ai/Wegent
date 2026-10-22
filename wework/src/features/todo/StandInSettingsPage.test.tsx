import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { StandInSettingsPage } from './StandInSettingsPage'

vi.mock('./StandInComposer', () => ({
  StandInComposer: () => <div data-testid="execution-settings" />,
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
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写每个角色的名称')
    expect(personalSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-role-name'))
    await user.paste('Review')
    await user.selectOptions(screen.getByTestId('stand-in-agent'), '42')
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByTestId('stand-in-role-select')).toHaveDisplayValue('Review')
    expect(screen.getByTestId('stand-in-scheduling-open')).toHaveTextContent(
      '所有角色、所有工作来源共用'
    )
    expect(personalSave).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        roles: [
          expect.objectContaining({ id: 'default' }),
          expect.objectContaining({ name: 'Review', agentResourceId: 42, enabled: false }),
        ],
      })
    )
  })

  it('connects all projects once and supports excluding individual projects', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
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
      })
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
      })
    )
    await user.click(screen.getByTestId('stand-in-connections-open'))
    expect(screen.queryByTestId('stand-in-all-projects')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-connect-project-two')).not.toBeInTheDocument()
  })

  it('discards connection drafts on Back and does not change saved configuration', async () => {
    const { props, personalSave } = fixture()
    const user = userSetup()
    render(<StandInSettingsPage {...props} />)
    await user.click(await screen.findByTestId('stand-in-connections-open'))
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
    expect(screen.getByTestId('stand-in-pending-save')).toHaveTextContent('保存后生效')
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
      expect.objectContaining({ autoSelect: true, roles: [second, first] })
    )
  })

  it('focuses the current project through the project entry without creating project-owned settings', async () => {
    const { props, personalGet } = fixture()
    render(<StandInSettingsPage {...props} initialProject={props.projects[1]} />)
    expect(await screen.findByTestId('stand-in-connections')).toBeInTheDocument()
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
