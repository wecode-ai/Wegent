import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocalProjectAgentForm, type LocalProjectAgentFormProps } from './LocalProjectAgentForm'

function fixture(agentId: string | null = null) {
  const props = {
    api: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    catalog: {
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
      deviceApi: { listDevices: vi.fn(async () => [{ device_type: 'local', device_id: 'local' }]) },
      pluginApi: { listPlugins: vi.fn(async () => []) },
    },
    projectId: 'local-project',
    projects: [],
    agentId,
    onClose: vi.fn(),
    onSaved: vi.fn(async () => undefined),
  }
  return props
}
function show(props: ReturnType<typeof fixture>) {
  render(<LocalProjectAgentForm {...(props as unknown as LocalProjectAgentFormProps)} />)
}

describe('LocalProjectAgentForm', () => {
  it('creates a local Agent with runtime defaults without cloud resources or models', async () => {
    const props = fixture()
    show(props)
    fireEvent.change(await screen.findByTestId('local-project-agent-name'), {
      target: { value: 'Local agent' },
    })
    fireEvent.change(screen.getByTestId('local-project-agent-runtime'), {
      target: { value: 'claude_code' },
    })
    fireEvent.change(screen.getByTestId('local-project-agent-instructions'), {
      target: { value: 'Review code' },
    })
    fireEvent.click(screen.getByTestId('local-project-agent-save'))
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
    expect(props.api.create).toHaveBeenCalledWith(
      'local-project',
      expect.objectContaining({
        name: 'Local agent',
        runtime: 'claude_code',
        systemPrompt: 'Review code',
        executionEnvironment: 'local',
        executionDeviceId: null,
      })
    )
    expect(props.api.update).not.toHaveBeenCalled()
  })

  it('does not create a replacement Agent when loading an existing Agent fails', async () => {
    const props = fixture('missing-agent')
    props.api.list.mockRejectedValue(new Error('Local database unavailable'))
    show(props)
    expect(await screen.findByRole('alert')).toHaveTextContent('Local database unavailable')
    fireEvent.change(screen.getByTestId('local-project-agent-name'), {
      target: { value: 'Do not save' },
    })
    expect(screen.getByTestId('local-project-agent-save')).toBeDisabled()
    expect(props.api.create).not.toHaveBeenCalled()
    expect(props.api.update).not.toHaveBeenCalled()
  })

  it('preserves saved local configuration and optimistic version on edit', async () => {
    const props = fixture('agent-1')
    const current = {
      id: 'agent-1',
      name: 'Existing',
      runtime: 'codex',
      version: 3,
      additionalSkills: [{ name: 'review', path: '/skills/review' }],
      mcpServers: { local: { command: 'server' } },
      plugins: [],
      workspacePolicy: 'git_worktree',
    }
    props.api.list.mockResolvedValue([current] as never[])
    show(props)
    fireEvent.change(await screen.findByTestId('local-project-agent-name'), {
      target: { value: 'Renamed' },
    })
    fireEvent.click(screen.getByTestId('local-project-agent-save'))
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
    expect(props.api.update).toHaveBeenCalledWith(
      'local-project',
      'agent-1',
      expect.objectContaining({
        name: 'Renamed',
        version: 3,
        additionalSkills: current.additionalSkills,
        mcpServers: current.mcpServers,
        workspacePolicy: 'git_worktree',
      })
    )
    expect(props.api.create).not.toHaveBeenCalled()
  })

  it('keeps a failed save visible and allows correction', async () => {
    const props = fixture()
    props.api.create.mockRejectedValue(new Error('Version conflict'))
    show(props)
    fireEvent.change(await screen.findByTestId('local-project-agent-name'), {
      target: { value: 'Local agent' },
    })
    fireEvent.click(screen.getByTestId('local-project-agent-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Version conflict')
    expect(props.onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('local-project-agent-save')).not.toBeDisabled()
  })
  it('opens and saves the form while the model catalog is pending, without reading plugins', async () => {
    const props = fixture()
    props.catalog.modelApi.listModels.mockReturnValue(new Promise(() => {}))
    show(props)
    fireEvent.change(await screen.findByTestId('local-project-agent-name'), {
      target: { value: 'Offline agent' },
    })
    expect(props.catalog.deviceApi.listDevices).not.toHaveBeenCalled()
    expect(props.catalog.pluginApi.listPlugins).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('local-project-agent-save'))
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
  })

  it('keeps edits and saving available while plugins load or fail', async () => {
    const props = fixture()
    let rejectPlugins!: (error: Error) => void
    props.catalog.pluginApi.listPlugins.mockReturnValue(
      new Promise((_, reject) => {
        rejectPlugins = reject
      })
    )
    show(props)
    fireEvent.change(await screen.findByTestId('local-project-agent-name'), {
      target: { value: 'Keep my edits' },
    })
    fireEvent.click(screen.getByTestId('local-project-agent-load-plugins'))
    await waitFor(() => expect(props.catalog.pluginApi.listPlugins).toHaveBeenCalledOnce())
    expect(screen.getByTestId('local-project-agent-save')).not.toBeDisabled()
    await act(async () => rejectPlugins(new Error('Plugin inventory unavailable')))
    expect(await screen.findByRole('alert')).toHaveTextContent('localAgent.pluginsFailed')
    expect(screen.getByTestId('local-project-agent-name')).toHaveValue('Keep my edits')
    props.catalog.pluginApi.listPlugins.mockResolvedValue([])
    fireEvent.click(screen.getByTestId('local-project-agent-load-plugins'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByTestId('local-project-agent-name')).toHaveValue('Keep my edits')
  })

  it('shows an unavailable saved model until the user explicitly changes it', async () => {
    const props = fixture('agent-1')
    props.api.list.mockResolvedValue([
      {
        id: 'agent-1',
        name: 'Existing',
        runtime: 'codex',
        version: 3,
        model: 'deepseek-v4-flash(自用)',
        additionalSkills: [],
        mcpServers: {},
        plugins: [],
      },
    ] as never[])
    show(props)
    expect(await screen.findByTestId('local-project-agent-model')).toHaveValue(
      'deepseek-v4-flash(自用)'
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('localAgent.modelUnavailable')
    expect(screen.getByTestId('local-project-agent-save')).toBeDisabled()
    fireEvent.change(screen.getByTestId('local-project-agent-model'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('local-project-agent-save'))
    await waitFor(() =>
      expect(props.api.update).toHaveBeenCalledWith(
        'local-project',
        'agent-1',
        expect.objectContaining({ model: null, version: 3 })
      )
    )
  })
  it('opens an existing Agent before models resolve and preserves edits when they arrive', async () => {
    const props = fixture('agent-1')
    props.api.list.mockResolvedValue([
      {
        id: 'agent-1',
        name: 'Existing',
        runtime: 'codex',
        version: 3,
        model: null,
        additionalSkills: [],
        mcpServers: {},
        plugins: [],
      },
    ] as never[])
    let resolveModels!: (value: { data: never[] }) => void
    props.catalog.modelApi.listModels.mockReturnValue(
      new Promise(resolve => {
        resolveModels = resolve
      })
    )
    show(props)
    expect(await screen.findByTestId('local-project-agent-name')).toHaveValue('Existing')
    fireEvent.change(screen.getByTestId('local-project-agent-name'), {
      target: { value: 'My draft' },
    })
    await act(async () => resolveModels({ data: [] }))
    expect(screen.getByTestId('local-project-agent-name')).toHaveValue('My draft')
    expect(screen.getByTestId('local-project-agent-save')).not.toBeDisabled()
  })

  it('allows model catalog retry without reloading the Agent or losing edits', async () => {
    const props = fixture()
    props.catalog.modelApi.listModels.mockRejectedValueOnce(new Error('Catalog unavailable'))
    show(props)
    fireEvent.change(await screen.findByTestId('local-project-agent-name'), {
      target: { value: 'My draft' },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('localAgent.modelsFailed')
    fireEvent.click(screen.getByTestId('local-project-agent-models-retry'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByTestId('local-project-agent-name')).toHaveValue('My draft')
    expect(props.catalog.modelApi.listModels).toHaveBeenCalledTimes(2)
  })
})
