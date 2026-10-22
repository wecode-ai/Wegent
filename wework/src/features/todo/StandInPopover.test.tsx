import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import { StandInPopover } from './StandInPopover'
import { createLocalProjectChatAgentApi } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

function fixture(initial: Partial<WorkspaceStandInSettings> = {}) {
  let settings: WorkspaceStandInSettings = {
    enabled: false,
    prompt: '',
    executionDeviceId: '',
    version: 0,
    ...initial,
  }
  const get = vi.fn(async () => settings)
  const save = vi.fn(async (_projectId: string, input: WorkspaceStandInSettings) => {
    settings = { ...input, version: settings.version + 1 }
    return settings
  })
  const api = {
    standIn: { get, save },
    agents: { list: vi.fn(async () => [{ id: 'reviewer', name: 'Reviewer', status: 'active' }]) },
    projects: {
      list: vi.fn(async () => []),
      listExecutionEnvironments: vi.fn(async () => [{ device_key: 'current', can_use: true }]),
    },
  } as unknown as SharedWorkspaceApi
  const project = {
    id: 'project',
    name: 'Current project',
    project_store: 'backend',
    access_role: 'Developer',
  } as CollaborationProject
  const props = {
    api,
    project,
    devices: [{ id: 1, device_id: 'current', name: 'MacBook', status: 'online' as const }],
    readLocalIdentity: vi.fn(async () => ({
      deviceId: 'current',
      runtimeInstanceId: 'instance',
      provenance: 'local-ipc' as const,
    })),
  }
  return { props, get, save }
}

describe('StandInPopover', () => {
  it('resolves reusable configurations to project names and excludes inaccessible projects', async () => {
    const { props, save } = fixture()
    props.api.projects.list = vi.fn(async () => [
      { ...props.project, id: '4712514671486395195', name: 'Release', project_store: 'backend' },
      { ...props.project, id: '4712514671486395195', name: 'Local tools', project_store: 'local' },
    ])
    const services = {
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
      standInApi: {
        catalog: vi.fn(async () => ({ models: [] })),
        list: vi.fn(async () => [
          {
            projectId: '4712514671486395195',
            projectStore: 'cloud',
            id: 'default',
            prompt: 'Cloud review',
            enabled: true,
          },
          {
            projectId: '4712514671486395195',
            projectStore: 'local',
            id: 'custom',
            name: 'Reviewer',
            prompt: 'Local review',
          },
          {
            projectId: '2753648597973755964',
            projectStore: 'cloud',
            id: 'default',
            prompt: 'Deleted',
          },
        ]),
      },
    } as unknown as WorkbenchServices
    const user = userEvent.setup()
    render(<StandInPopover {...props} services={services} userId={7} />)
    await user.click(screen.getByTestId('stand-in-open'))
    const reuse = await screen.findByTestId('stand-in-reuse-select')
    expect(screen.getByRole('option', { name: 'Release', exact: true })).toBeInTheDocument()
    expect(reuse).toHaveTextContent('Local tools · Reviewer')
    expect(reuse).not.toHaveTextContent('4712514671486395195')
    expect(reuse).not.toHaveTextContent('2753648597973755964')
    await user.selectOptions(reuse, '0')
    expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent('Cloud review')
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'false')
    expect(save).not.toHaveBeenCalled()
  })

  it('saves personal settings regardless of the project role or resource catalogs', async () => {
    const { props, save } = fixture({ agentId: 'missing-agent', version: 1 })
    props.project.access_role = 'Viewer'
    props.api.agents.list = vi.fn(async () => {
      throw new Error('Catalog unavailable')
    })
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({ agentId: 'missing-agent' })
    )
  })

  it('shows an Agent created outside the cached client when opened', async () => {
    const { props } = fixture()
    let records: Array<{ id: string; name: string; runtime: string; status: string }> = []
    const request = vi.fn(async () => records)
    const localAgents = createLocalProjectChatAgentApi(request, 1)
    props.api.agents.list = (projectId, options) => localAgents.list(projectId, options)
    await props.api.agents.list(props.project.id)
    records = [{ id: 'external', name: 'External Agent', runtime: 'codex', status: 'active' }]
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    expect(request).toHaveBeenCalledOnce()
    await user.click(screen.getByTestId('stand-in-open'))
    expect(await screen.findByRole('option', { name: 'External Agent' })).toHaveValue('external')
    expect(request).toHaveBeenCalledTimes(2)
    const toggle = await screen.findByTestId('stand-in-auto')
    await user.click(toggle)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('saves the selected automatic state without waiting for model readiness', async () => {
    const model = { runtime: 'codex' as const, provider: 'local', model_id: 'default' }
    const { props, save } = fixture({ executionDeviceId: 'current', version: 2, model })
    let finishCatalog!: (catalog: { models: (typeof model)[] }) => void
    const catalog = new Promise<{ models: (typeof model)[] }>(resolve => {
      finishCatalog = resolve
    })
    const services = {
      standInApi: { catalog: vi.fn(() => catalog) },
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
    } as unknown as WorkbenchServices
    const user = userEvent.setup()
    render(<StandInPopover {...props} services={services} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.click(screen.getByTestId('stand-in-auto'))
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('stand-in-save')).toBeEnabled()
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith('project', expect.objectContaining({ enabled: true, model }))
    await act(async () => finishCatalog({ models: [model] }))
  })

  it('saves the loaded default model before enabling a reopened manual configuration', async () => {
    const { props, save } = fixture()
    let finishCatalog!: (catalog: { models: Record<string, unknown>[] }) => void
    const catalog = new Promise<{ models: Record<string, unknown>[] }>(resolve => {
      finishCatalog = resolve
    })
    const services = {
      standInApi: { catalog: vi.fn(() => catalog) },
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
    } as unknown as WorkbenchServices
    const user = userEvent.setup()
    render(<StandInPopover {...props} services={services} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.type(await screen.findByTestId('stand-in-prompt'), 'Manual settings')
    expect(screen.getByTestId('stand-in-save')).toBeEnabled()
    await act(async () =>
      finishCatalog({
        models: [{ runtime: 'codex', provider: 'local', model_id: 'default', is_default: true }],
      })
    )
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() => expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument())
    expect(save).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({ model: expect.objectContaining({ model_id: 'default' }) })
    )
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    await waitFor(() =>
      expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
    )
    expect(screen.queryByTestId('stand-in-enable-notice')).not.toBeInTheDocument()
    expect(save).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('project', expect.objectContaining({ enabled: true }))
  })

  it('locks the form only while saving the complete draft', async () => {
    const { props, save, get } = fixture({ executionDeviceId: 'current', version: 2 })
    let finishSave!: (settings: WorkspaceStandInSettings) => void
    save.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSave = resolve
        })
    )
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.click(screen.getByTestId('stand-in-auto'))
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(screen.getByTestId('stand-in-auto')).toBeDisabled()
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
    const result = { ...save.mock.calls[0][1], version: 3 }
    get.mockResolvedValue(result)
    await act(async () => finishSave(result))
    expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-enabled')).toBeInTheDocument()
  })

  it('keeps the stand-in popover open while searching its local project menu', async () => {
    const { props } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    await user.click(screen.getByTestId('project-work-button'))
    const search = await screen.findByTestId('project-search-input')
    await user.type(search, 'Wegent')
    expect(search).toHaveValue('Wegent')
    expect(screen.getByTestId('stand-in-settings')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-prompt')).toBeInTheDocument()
  })
  it('does not call an empty device selection the current device', async () => {
    const { props } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} readLocalIdentity={async () => null} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    const device = await screen.findByTestId('stand-in-device')
    expect(device).toHaveValue('')
    expect(device).toHaveAccessibleName(/在哪里处理|Where to work/)
    expect(screen.getByRole('option', { name: 'MacBook' })).toBeInTheDocument()
    expect(screen.queryByText(/当前设备|Current device/)).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-save')).toBeDisabled()
  })

  it('defaults to the current device and saves only after explicit confirmation', async () => {
    const { props, save } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    expect(await screen.findByTestId('stand-in-prompt')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-save')).toHaveTextContent('保存')
    expect(screen.getByTestId('stand-in-cancel')).toBeInTheDocument()
    const automatic = screen.getByRole('checkbox', { name: '自动处理分配给我的任务' })
    expect(automatic).toBe(screen.getByTestId('stand-in-auto'))
    expect(automatic).not.toBeChecked()
    expect(automatic).toHaveAccessibleDescription(/保存后生效/)
    expect(
      screen.getByTestId('stand-in-prompt').compareDocumentPosition(automatic) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await user.click(screen.getByText('自动处理分配给我的任务'))
    expect(automatic).toBeChecked()
    await waitFor(() => expect(screen.getByTestId('stand-in-device')).toHaveValue('current'))
    expect(
      screen.getByRole('option', { name: /MacBook.*当前设备|MacBook.*Current device/ })
    ).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-open').querySelector('svg')).toHaveAttribute(
      'data-state',
      'disabled'
    )
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('stand-in-save')).toHaveTextContent('保存')
    await user.type(screen.getByTestId('stand-in-prompt'), 'Check the evidence')
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({
          enabled: true,
          executionDeviceId: 'current',
          prompt: 'Check the evidence',
        })
      )
    )
    await waitFor(() => expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument())
    expect(screen.getByTestId('stand-in-enabled')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-open').querySelectorAll('circle')).toHaveLength(2)
  })

  it('saves manual-only settings while automatic handling remains off', async () => {
    const { props, save } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.type(screen.getByTestId('stand-in-prompt'), 'Manual review')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({ enabled: false, prompt: 'Manual review' })
      )
    )
  })

  it('cancels a pending first activation without saving or hiding configuration', async () => {
    const { props, save } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByTestId('stand-in-auto'))
    expect(screen.queryByTestId('stand-in-enable-notice')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-prompt')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-save')).toHaveTextContent('保存')
    expect(save).not.toHaveBeenCalled()
  })

  it('discards an existing configuration toggle on cancel', async () => {
    const { props, save } = fixture({ prompt: 'Saved', executionDeviceId: 'current', version: 2 })
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.click(screen.getByTestId('stand-in-auto'))
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-cancel'))
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'false')
    expect(save).not.toHaveBeenCalled()
  })

  it('saves automatic handling and configuration edits together', async () => {
    const { props, save } = fixture({
      enabled: true,
      prompt: 'Saved',
      executionDeviceId: 'current',
      version: 2,
    })
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.type(screen.getByTestId('stand-in-prompt'), '{End} draft')
    await user.click(screen.getByTestId('stand-in-auto'))
    await waitFor(() =>
      expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'false')
    )
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent('Saved draft')
    await user.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenLastCalledWith(
      'project',
      expect.objectContaining({ enabled: false, prompt: 'Saved draft', version: 2 })
    )
  })

  it('requires explicit save and enable when there are pending edits', async () => {
    const { props, save } = fixture({ enabled: false, executionDeviceId: 'current', version: 2 })
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.type(screen.getByTestId('stand-in-prompt'), 'New instructions')
    await user.click(screen.getByTestId('stand-in-auto'))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('stand-in-enable-notice')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({ enabled: true, prompt: 'New instructions' })
    )
  })

  it('retains the selected automatic state and edits after saving fails', async () => {
    const { props, save } = fixture({ enabled: true, executionDeviceId: 'current', version: 2 })
    save.mockRejectedValueOnce(new Error('Toggle failed'))
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-prompt')
    await user.type(screen.getByTestId('stand-in-prompt'), 'Keep draft')
    await user.click(screen.getByTestId('stand-in-auto'))
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Toggle failed')
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent('Keep draft')
    expect(screen.getByTestId('stand-in-auto')).toBeEnabled()
  })

  it('lets users choose a project agent and saves its reference with supplementary instructions', async () => {
    const { props, save } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    await screen.findByRole('option', { name: 'Reviewer' })
    await user.selectOptions(screen.getByTestId('stand-in-agent'), 'reviewer')
    await user.type(screen.getByTestId('stand-in-prompt'), 'Check regressions')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({ agentId: 'reviewer', prompt: 'Check regressions', enabled: true })
      )
    )
  })

  it('loads the selected device configuration and version before saving', async () => {
    const { props, get, save } = fixture()
    get.mockImplementation(async (_project?: string, device?: string) => ({
      enabled: true,
      prompt: device === 'cloud' ? 'Cloud prompt' : '',
      executionDeviceId: device || 'current',
      version: device === 'cloud' ? 9 : 1,
    }))
    const user = userEvent.setup()
    render(
      <StandInPopover
        {...props}
        devices={[...props.devices, { id: 2, device_id: 'cloud', name: 'Cloud', status: 'online' }]}
      />
    )
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-device')
    await user.selectOptions(screen.getByTestId('stand-in-device'), 'cloud')
    await waitFor(() =>
      expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent('Cloud prompt')
    )
    expect(get).toHaveBeenLastCalledWith('project', 'cloud')
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({ executionDeviceId: 'cloud', version: 9 })
      )
    )
    await waitFor(() => expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument())
    await user.click(screen.getByTestId('stand-in-open'))
    await waitFor(() => expect(screen.getByTestId('stand-in-device')).toHaveValue('cloud'))
    expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent('Cloud prompt')
  })

  it('blocks edits until the selected device settings finish loading', async () => {
    const { props, get } = fixture()
    let finishLoad!: (settings: WorkspaceStandInSettings) => void
    const pending = new Promise<WorkspaceStandInSettings>(resolve => {
      finishLoad = resolve
    })
    get.mockImplementation(async (_project?: string, device?: string) =>
      device === 'cloud'
        ? pending
        : { enabled: true, prompt: '', executionDeviceId: 'current', version: 0 }
    )
    const user = userEvent.setup()
    render(
      <StandInPopover
        {...props}
        devices={[...props.devices, { id: 2, device_id: 'cloud', name: 'Cloud', status: 'online' }]}
      />
    )
    await user.click(screen.getByTestId('stand-in-open'))
    await screen.findByTestId('stand-in-device')
    await user.selectOptions(screen.getByTestId('stand-in-device'), 'cloud')
    expect(screen.getByTestId('stand-in-auto')).toBeDisabled()
    expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-prompt')).not.toBeInTheDocument()
    finishLoad({ enabled: true, prompt: 'Loaded', executionDeviceId: 'cloud', version: 1 })
    await waitFor(() => expect(screen.getByTestId('stand-in-auto')).toBeEnabled())
    expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent('Loaded')
  })

  it('discards edits on cancel and Escape without calling save', async () => {
    const { props, save } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    await screen.findByTestId('stand-in-prompt')
    await user.type(screen.getByTestId('stand-in-prompt'), 'Unsaved')
    await user.click(screen.getByTestId('stand-in-cancel'))
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    await waitFor(() => expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent(''))
    await user.keyboard('{Escape}')
    expect(save).not.toHaveBeenCalled()
    expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument()
  })

  it('keeps drafts visible after save failure and prevents saving after load failure', async () => {
    const { props, get, save } = fixture()
    save.mockRejectedValueOnce(new Error('Save failed'))
    const user = userEvent.setup()
    const view = render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    await screen.findByTestId('stand-in-prompt')
    await user.type(screen.getByTestId('stand-in-prompt'), 'Keep this draft')
    await user.click(screen.getByTestId('stand-in-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed')
    expect(screen.getByTestId('stand-in-prompt')).toHaveTextContent('Keep this draft')
    view.unmount()
    get.mockRejectedValue(new Error('Load failed'))
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')
    expect(screen.queryByTestId('stand-in-save')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-auto')).toBeDisabled()
  })
})
