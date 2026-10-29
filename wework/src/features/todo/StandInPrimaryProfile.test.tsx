import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { runnerModelKey } from '@wegent/collaboration'
import type { CollaborationProject } from '@wegent/collaboration'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorkListResponse } from '@/types/api'
import '@/i18n'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'

vi.mock('@/components/layout/useProjectWorktreeAvailabilityProbe', () => ({
  useProjectWorktreeAvailabilityProbe: () => null,
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

it('consolidates saved instructions without losing content and keeps connection rules out of the overview', async () => {
  const props = fixture()
  const user = userEvent.setup()
  render(<StandInPrimaryProfile {...props} />)
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue(
    'Review my work\n\nKeep replies concise'
  )
  const connections = screen.getByTestId('stand-in-connection-settings')
  expect(within(connections).getByText('Design team')).toBeInTheDocument()
  expect(within(connections).queryByRole('combobox')).not.toBeInTheDocument()
  expect(within(connections).queryByRole('checkbox')).not.toBeInTheDocument()
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
