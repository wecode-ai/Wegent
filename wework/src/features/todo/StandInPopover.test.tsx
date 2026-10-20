import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import { StandInPopover } from './StandInPopover'

function fixture() {
  let settings: WorkspaceStandInSettings = {
    enabled: false,
    prompt: '',
    executionDeviceId: '',
    version: 0,
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
    expect(screen.queryByTestId('stand-in-prompt')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-save')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-cancel')).not.toBeInTheDocument()
    expect(await screen.findByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByTestId('stand-in-auto'))
    await waitFor(() => expect(screen.getByTestId('stand-in-device')).toHaveValue('current'))
    expect(
      screen.getByRole('option', { name: /MacBook.*当前设备|MacBook.*Current device/ })
    ).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-open').querySelectorAll('circle')).toHaveLength(2)
    expect(screen.getByTestId('stand-in-auto')).toHaveAttribute('aria-checked', 'true')
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

  it('saves manual-only edits after enabling and disabling an initially disabled profile', async () => {
    const { props, save } = fixture()
    const user = userEvent.setup()
    render(<StandInPopover {...props} />)
    await user.click(screen.getByTestId('stand-in-open'))
    await user.click(await screen.findByTestId('stand-in-auto'))
    await user.type(screen.getByTestId('stand-in-prompt'), 'Manual review')
    await user.click(screen.getByTestId('stand-in-auto'))
    expect(screen.queryByTestId('stand-in-prompt')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-save'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({ enabled: false, prompt: 'Manual review' })
      )
    )
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
