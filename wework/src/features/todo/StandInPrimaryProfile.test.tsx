import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { runnerModelKey } from '@wegent/collaboration'
import type { CollaborationProject } from '@wegent/collaboration'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorkListResponse } from '@/types/api'
import type { StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'

vi.mock('@/components/layout/useProjectWorktreeAvailabilityProbe', () => ({
  useProjectWorktreeAvailabilityProbe: () => null,
}))
vi.mock('@/features/automations/AutomationsPage', () => ({
  AutomationsPage: () => <div data-testid="calendar-editor-fixture" />,
}))
vi.mock('@/features/dsh-runtime/dshExtensions', () => ({
  getDshExtensionHost: () => ({ backend: { scope: () => ({ request: async () => [] }) } }),
}))

function fixture() {
  const work = {
    chats: [],
    projects: [
      {
        project: { id: 17, key: 'repo', name: 'Repository' },
        deviceWorkspaces: [
          { id: 1, deviceId: 'mac', workspacePath: '/repo', available: true, tasks: [] },
        ],
      },
    ],
  } as RuntimeWorkListResponse
  return {
    settings: {
      userId: 7,
      executionDeviceId: 'mac',
      version: 0,
      roles: [],
      primary: {
        enabled: true,
        prompt: 'Review my work',
        preferences: 'Keep replies concise',
        connections: [
          {
            providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
            id: 'group',
            name: 'Design team',
            kind: 'group' as const,
            profile: 'corp',
            policy: { automatic: true, askBeforeAct: true },
          },
        ],
      },
    } as PersonalStandInSettings,
    saving: false,
    error: null,
    onSave: vi.fn(async () => {}),
    onClose: vi.fn(),
    onSelectDevice: vi.fn(),
    localDeviceId: 'mac',
    projects: [],
    devices: [
      { id: 1, device_id: 'mac', name: 'Mac', status: 'online' as const },
      { id: 2, device_id: 'remote', name: 'Remote', status: 'online' as const },
    ],
    services: {
      standInApi: {
        catalog: async () => ({
          models: [{ runtime: 'codex', provider: 'local', model_id: 'profile-model' }],
        }),
      },
      modelApi: { listModels: async () => ({ data: [] }) },
      runtimeWorkApi: { listRuntimeWork: vi.fn(async () => work) },
    } as unknown as WorkbenchServices,
  }
}

it('explains an environment load failure and recovers without losing profile edits', async () => {
  const props = fixture()
  const listRuntimeWork = vi.mocked(props.services.runtimeWorkApi!.listRuntimeWork)
  listRuntimeWork.mockRejectedValueOnce(new Error('internal failure'))
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('未能加载所选设备的项目和工作目录')
  await user.type(screen.getByTestId('stand-in-preferences'), ' draft')
  await user.click(screen.getByTestId('stand-in-primary-environment-retry'))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue(
    'Review my work\n\nKeep replies concise draft'
  )
  expect(props.onSave).not.toHaveBeenCalled()
})

it('keeps existing identity and execution settings without a global processing switch', () => {
  const props = fixture()
  render(<StandInPrimaryProfile {...props} />)
  expect(screen.queryByTestId('stand-in-primary-enabled')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-preferences')).toBeInTheDocument()
  expect(screen.getByTestId('stand-in-device')).toBeInTheDocument()
  expect(screen.getByTestId('stand-in-primary-execution')).toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-processing-mode')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-processing-interval')).not.toBeInTheDocument()
  expect(props.onSave).not.toHaveBeenCalled()
})

it('consumes a menu calendar deep link once and returns to the connection list on normal navigation', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} initialCalendar />)
  expect(screen.getByTestId('stand-in-calendar-connection')).toBeVisible()
  expect(screen.queryByText('返回连接')).not.toBeInTheDocument()
  expect(screen.getAllByTestId('stand-in-connections-back')).toHaveLength(1)
  await user.click(screen.getByTestId('stand-in-connections-back'))
  await user.click(screen.getByTestId('stand-in-primary-back-to-settings'))
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  expect(screen.getByTestId('stand-in-time-connections')).toBeVisible()
  expect(screen.queryByTestId('stand-in-calendar-connection')).not.toBeInTheDocument()
})

it('provides clickable paths through all three primary settings levels and re-enters a source', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  await screen.findByTestId('stand-in-path-connections')
  await user.click(screen.getByTestId('stand-in-time-connections'))
  expect(await screen.findByTestId('stand-in-path-source')).toHaveTextContent('日历')
  await user.click(screen.getByTestId('stand-in-path-connections'))
  expect(screen.queryByTestId('stand-in-calendar-connection')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-path-settings'))
  expect(screen.getByTestId('stand-in-preferences')).toBeVisible()
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  await user.click(screen.getByTestId('stand-in-time-connections'))
  expect(screen.getByTestId('stand-in-calendar-connection')).toBeVisible()
})

it('protects an unsaved mailbox when returning from the primary connections header', async () => {
  const props = fixture()
  const provider = '@wegent/dsh-connection-runtime/email'
  const api = {
    connectionProviders: async () => ({
      items: [
        { id: provider, displayName: '邮箱', dependencies: [], availability: { status: 'ready' } },
      ],
    }),
  } as unknown as StandInExecutorApi
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} api={api} />)
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  await user.click(await screen.findByTestId(`stand-in-add-${provider}-connection`))
  await user.click(screen.getByTestId('stand-in-email-add'))
  fireEvent.change(screen.getByTestId('stand-in-email-email'), {
    target: { value: 'owner@example.com' },
  })
  expect(screen.getAllByTestId('stand-in-connections-back')).toHaveLength(1)
  await user.click(screen.getByTestId('stand-in-connections-back'))
  expect(screen.getByTestId('stand-in-email-discard')).toBeVisible()
  await user.click(screen.getByTestId('stand-in-email-discard-cancel-button'))
  expect(screen.getByTestId('stand-in-email-email')).toHaveValue('owner@example.com')
  await user.click(screen.getByTestId('stand-in-connections-back'))
  await user.click(screen.getByTestId('stand-in-email-discard'))
  expect(screen.queryByTestId('stand-in-email-connections')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-primary-back-to-settings'))
  expect(screen.getByTestId('stand-in-primary-connections-open')).toBeVisible()
  expect(props.onSave).not.toHaveBeenCalled()
})

it('does not save changed instructions when the user discards the draft', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  await user.type(screen.getByTestId('stand-in-preferences'), ' changed')
  await user.click(screen.getByTestId('stand-in-primary-cancel'))
  expect(props.onSave).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-primary-discard'))
  expect(props.onClose).toHaveBeenCalledOnce()
  expect(props.onSave).not.toHaveBeenCalled()
})

it('consolidates saved instructions without losing content and keeps connection rules out of the overview', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue(
    'Review my work\n\nKeep replies concise'
  )
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  const connections = screen.getByTestId('stand-in-connection-settings')
  expect(within(connections).getByText('Design team')).toBeInTheDocument()
  expect(within(connections).queryByRole('combobox')).not.toBeInTheDocument()
  expect(within(connections).queryByRole('checkbox')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-primary-back-to-settings'))
  await user.type(screen.getByTestId('stand-in-preferences'), '; ask before sending')
  await user.click(screen.getByTestId('stand-in-primary-save'))
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      primary: expect.objectContaining({
        prompt: '',
        preferences: 'Review my work\n\nKeep replies concise; ask before sending',
      }),
    })
  )
})

it('returns from connections without discarding the profile draft', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  await user.type(screen.getByTestId('stand-in-preferences'), '; keep this draft')
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  await user.click(screen.getByTestId('stand-in-primary-back-to-settings'))
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue(
    'Review my work\n\nKeep replies concise; keep this draft'
  )
  expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()
  expect(props.onSave).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
})

it('persists real project and model selections and protects unsaved changes when switching devices', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  await user.selectOptions(screen.getByTestId('stand-in-device'), 'remote')
  expect(props.onSelectDevice).toHaveBeenCalledWith('remote')
  await waitFor(() =>
    expect(props.services.runtimeWorkApi.listRuntimeWork).toHaveBeenCalledWith({ deviceId: 'mac' })
  )
  await user.click(screen.getByTestId('project-work-button'))
  await user.click(await screen.findByTestId('project-option-17'))
  expect(screen.getByTestId('stand-in-device')).toBeDisabled()
  await user.click(screen.getByTestId('model-selector-button'))
  await user.click(
    await screen.findByTestId(
      `model-option-${runnerModelKey({ runtime: 'codex', provider: 'local', model_id: 'profile-model' })}`
    )
  )
  await user.click(screen.getByTestId('stand-in-primary-save'))
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      primary: expect.objectContaining({
        workspace: expect.objectContaining({ workspacePath: '/repo' }),
        model: expect.objectContaining({ model_id: 'profile-model' }),
        modelOptions: expect.objectContaining({ modelSelection: 'model' }),
      }),
    })
  )
})

it('shows existing local connection names on a remote device while limiting new selections', async () => {
  const props = fixture()
  props.settings.executionDeviceId = 'remote'
  props.settings.primary!.collaboration = {
    enabled: true,
    allProjects: false,
    projects: [{ id: 'local-project', store: 'local' }],
    excludedProjects: [],
    tags: [],
  }
  const projects = [
    { id: 'local-project', name: 'Local review project', project_store: 'local' },
    { id: 'cloud-project', name: 'Cloud review project', project_store: 'backend' },
  ] as CollaborationProject[]
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} projects={projects} />)
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  const row = screen.getByTestId('stand-in-connection-project-local-local-project')
  expect(row).toHaveTextContent('Local review project')
  await user.click(row)
  expect(screen.getByRole('checkbox', { name: 'Local review project' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Cloud review project' })).not.toBeChecked()
  await user.click(screen.getByRole('checkbox', { name: 'Local review project' }))
  expect(screen.queryByRole('checkbox', { name: 'Local review project' })).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-primary-save'))
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      primary: expect.objectContaining({
        collaboration: expect.objectContaining({ projects: [] }),
      }),
    })
  )
})

it('marks first-time collaboration edits pending against the fixed default scope', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  await user.click(screen.getByTestId('stand-in-primary-connections-open'))
  expect(screen.queryByTestId('stand-in-connections-pending')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-add-projects-connection'))
  await user.click(screen.getByTestId('stand-in-source-collaboration'))
  expect(screen.getByTestId('stand-in-connections-pending')).toBeVisible()
  await user.click(screen.getByTestId('stand-in-source-collaboration'))
  expect(screen.queryByTestId('stand-in-connections-pending')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-primary-save')).toBeDisabled()
  await user.click(screen.getByTestId('stand-in-primary-cancel'))
  expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()
  expect(props.onClose).toHaveBeenCalledExactlyOnceWith()
})
