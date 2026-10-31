import {
  WorkspaceTabsContext,
  type WorkspaceTabsContextValue,
} from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cloudRunnerModels,
  runnerModelKey,
  type WorkspaceStandInSettings,
  type WorkspaceProjectAgent,
} from '@wegent/collaboration'
import type { RuntimeWorkListResponse } from '@/types/api'
import '@/i18n'
import { installDshUiTestContributions } from '@/test/setup'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { StandInComposer } from './StandInComposer'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

vi.mock('@/components/layout/useProjectWorktreeAvailabilityProbe', () => ({
  useProjectWorktreeAvailabilityProbe: ({ key }: { key: string }) => ({
    key,
    availability: {
      available: true,
      reason: 'available',
      deviceId: 'mac',
      sourcePath: '/repo',
    },
  }),
}))

const work = {
  chats: [],
  projects: [
    {
      project: { id: 17, key: 'repo', name: 'Repository' },
      deviceWorkspaces: [
        { id: 1, deviceId: 'mac', workspacePath: '/repo', available: true, tasks: [] },
      ],
    },
    {
      project: { id: 18, key: 'other', name: 'Other device project' },
      deviceWorkspaces: [
        { deviceId: 'other', workspacePath: '/other', available: true, tasks: [] },
      ],
    },
  ],
} as RuntimeWorkListResponse

function Fixture({
  save,
  initial,
  services,
  selectedAgent,
  showPrompt = true,
}: {
  save: ReturnType<typeof vi.fn>
  initial?: WorkspaceStandInSettings['workspace']
  services?: WorkbenchServices
  selectedAgent?: WorkspaceProjectAgent
  showPrompt?: boolean
}) {
  const [draft, setDraft] = useState<WorkspaceStandInSettings>({
    enabled: false,
    prompt: '',
    executionDeviceId: 'mac',
    version: 0,
    workspace: initial,
  })
  const [valid, setValid] = useState(false)
  return (
    <>
      <StandInComposer
        draft={draft}
        selectedAgent={selectedAgent}
        showPrompt={showPrompt}
        onChange={setDraft}
        onSave={async prompt => save({ ...draft, prompt })}
        onValidityChange={setValid}
        disabled={false}
        submitDisabled={false}
        controls={<button data-testid="stand-in-agent">Agent</button>}
        deviceControl={<button data-testid="stand-in-device">Mac</button>}
        runtimeWork={work}
        services={services}
        devices={[{ id: 1, device_id: 'mac', name: 'Mac', status: 'online' }]}
      />
      <button data-testid="stand-in-save" disabled={!valid} onClick={() => save(draft)}>
        Save
      </button>
    </>
  )
}

describe('Stand-in configuration composer', () => {
  beforeEach(async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.projectWorkSection]: [
          { id: 'git-project-work', module: 'plugins/wework-ui-git-project-work-section.js' },
        ],
      },
      {
        'plugins/wework-ui-git-project-work-section.js': () =>
          import('../../../dsh/ui-git/src/project-work-section'),
      }
    )
  })
  it.each(['内网', '公网'])(
    'distinguishes same-name network models and saves the %s resource identity',
    async region => {
      const save = vi.fn(async () => true)
      const catalog = ['内网', '公网'].map(network => ({
        name: `kimi-k3(${network})`,
        displayName: `${network}:Kimi-K3`,
        modelId: 'kimi-k3',
        type: 'public' as const,
        provider: 'openai',
        namespace: 'default',
        resourceUserId: 0,
        config: { protocol: 'openai-responses' },
      }))
      const services = {
        standInApi: { catalog: vi.fn(async () => ({ models: [] })) },
        modelApi: { listModels: vi.fn(async () => ({ data: catalog })) },
      } as unknown as WorkbenchServices
      render(<Fixture save={save} services={services} />)
      await waitFor(() =>
        expect(screen.getByTestId('model-selector-button')).toHaveTextContent('内网:Kimi-K3')
      )
      await userEvent.click(screen.getByTestId('model-selector-button'))
      const cloudGroup = screen.getByTestId('model-source-cloud')
      expect(within(cloudGroup).getByText('内网:Kimi-K3')).toBeInTheDocument()
      expect(within(cloudGroup).getByText('公网:Kimi-K3')).toBeInTheDocument()
      const selected = cloudRunnerModels(catalog).find(
        model => model.runtime === 'codex' && model.label === `${region}:Kimi-K3`
      )!
      await userEvent.click(screen.getByTestId(`model-option-${runnerModelKey(selected)}`))
      await userEvent.keyboard('{Escape}')
      expect(screen.getByTestId('model-selector-button')).toHaveTextContent(`${region}:Kimi-K3`)
      await userEvent.click(screen.getByTestId('stand-in-save'))
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          model: {
            runtime: selected.runtime,
            provider: selected.provider,
            model_id: selected.model_id,
            source: selected.source,
            cloud_model: selected.cloud_model,
          },
        })
      )
    }
  )

  it('persists a fixed agent model when agent details arrive after the default model', async () => {
    const save = vi.fn()
    const model = {
      runtime: 'codex' as const,
      provider: 'local',
      model_id: 'default',
      is_default: true,
    }
    const services = {
      standInApi: { catalog: vi.fn(async () => ({ models: [model] })) },
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
    } as unknown as WorkbenchServices
    const { rerender } = render(<Fixture save={save} services={services} />)
    await waitFor(() => expect(screen.getByTestId('stand-in-save')).toBeEnabled())
    const fixed = { runtime: 'codex' as const, provider: 'local', model_id: 'fixed' }
    rerender(
      <Fixture
        save={save}
        services={services}
        selectedAgent={{
          id: 'reviewer',
          name: 'Reviewer',
          runtime: 'codex',
          modelPolicy: { mode: 'fixed', model: fixed },
        }}
      />
    )
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ model: fixed }))
  })

  it('keeps advanced settings unchanged when the default model catalog arrives', async () => {
    const save = vi.fn()
    const model = {
      runtime: 'codex' as const,
      provider: 'local',
      model_id: 'default',
      is_default: true,
    }
    const services = {
      standInApi: { catalog: vi.fn(async () => ({ models: [model] })) },
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
    } as unknown as WorkbenchServices
    render(<Fixture save={save} services={services} showPrompt={false} />)
    await waitFor(() =>
      expect(screen.getByTestId('model-selector-button')).toHaveTextContent('default')
    )
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save.mock.calls[0][0].model).toBeUndefined()
  })

  it('allows settings to be saved while the model catalog is loading', async () => {
    const save = vi.fn(async () => true)
    const model = {
      runtime: 'codex' as const,
      provider: 'local',
      model_id: 'default-model',
      label: 'Default model',
      is_default: true,
    }
    let finishCatalog!: (catalog: { models: (typeof model)[] }) => void
    const catalog = new Promise<{ models: (typeof model)[] }>(resolve => {
      finishCatalog = resolve
    })
    const services = {
      standInApi: { catalog: vi.fn(() => catalog) },
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
    } as unknown as WorkbenchServices
    render(<Fixture save={save} services={services} />)
    expect(screen.getByTestId('stand-in-save')).toBeEnabled()
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledOnce()
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument()
    await act(async () => finishCatalog({ models: [model] }))
    await waitFor(() => expect(screen.getByTestId('stand-in-save')).toBeEnabled())
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.objectContaining({ model_id: 'default-model' }) })
    )
  })

  it('selects and saves the device default model without requiring an extra choice', async () => {
    const save = vi.fn(async () => true)
    const model = {
      runtime: 'codex',
      provider: 'local',
      source: 'native',
      model_id: 'default-model',
      label: 'Default model',
      is_default: true,
    }
    const services = {
      standInApi: {
        catalog: vi.fn(async () => ({
          models: [{ ...model, model_id: 'first', label: 'First', is_default: false }, model],
        })),
      },
      modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
    } as unknown as WorkbenchServices
    render(<Fixture save={save} services={services} />)
    await waitFor(() =>
      expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Default model')
    )
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.objectContaining({ model_id: 'default-model' }) })
    )
  })
  it.each(['native', 'cloud'] as const)(
    'separates same-name account and cloud models and saves the %s identity',
    async source => {
      const save = vi.fn(async () => true)
      const native = {
        runtime: 'codex' as const,
        provider: 'openai',
        model_id: 'gpt-6.1-sol',
        label: 'GPT-6.1-Sol',
        account_label: 'ChatGPT',
        is_default: true,
      }
      const custom = {
        ...native,
        provider: 'custom',
        account_label: 'Custom provider',
        is_default: false,
      }
      const cloud = {
        runtime: 'codex' as const,
        provider: 'openai',
        model_id: native.model_id,
        source: 'cloud' as const,
        cloud_model: {
          name: 'cloud-sol',
          type: 'public' as const,
          namespace: 'default',
          resource_user_id: 1,
        },
      }
      const services = {
        standInApi: { catalog: vi.fn(async () => ({ models: [native, custom] })) },
        modelApi: {
          listModels: vi.fn(async () => ({
            data: [
              {
                name: cloud.cloud_model.name,
                displayName: native.label,
                modelId: native.model_id,
                type: 'public',
                provider: 'openai',
                namespace: 'default',
                resourceUserId: 1,
                config: { protocol: 'openai-responses' },
              },
            ],
          })),
        },
      } as unknown as WorkbenchServices
      render(<Fixture save={save} services={services} />)
      await waitFor(() =>
        expect(screen.getByTestId('model-selector-button')).toHaveTextContent(native.label)
      )
      await userEvent.click(screen.getByTestId('model-selector-button'))
      const localGroup = screen.getByTestId('model-source-local-chatgpt')
      const cloudGroup = screen.getByTestId('model-source-cloud')
      const customGroup = screen.getByTestId('model-source-custom')
      expect(within(localGroup).getByText(native.label)).toBeInTheDocument()
      expect(within(cloudGroup).getByText(native.label, { exact: false })).toBeInTheDocument()
      expect(within(customGroup).getByText(native.label)).toBeInTheDocument()
      expect(localGroup).toContainElement(
        screen.getByTestId(`model-option-${runnerModelKey(native)}`)
      )
      expect(cloudGroup).toContainElement(
        screen.getByTestId(`model-option-${runnerModelKey(cloud)}`)
      )
      expect(customGroup).toContainElement(
        screen.getByTestId(`model-option-${runnerModelKey(custom)}`)
      )
      const selected = source === 'native' ? native : cloud
      await userEvent.click(screen.getByTestId(`model-option-${runnerModelKey(selected)}`))
      await userEvent.click(screen.getByTestId('stand-in-save'))
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.objectContaining({
            provider: selected.provider,
            model_id: selected.model_id,
            ...(source === 'cloud' ? { source: 'cloud', cloud_model: cloud.cloud_model } : {}),
          }),
        })
      )
    }
  )
  it('saves empty optional instructions without copying the dynamic placeholder', async () => {
    const save = vi.fn(async () => true)
    render(<Fixture save={save} />)
    expect(screen.getByTestId('stand-in-prompt')).toHaveAttribute('contenteditable', 'true')
    expect(screen.getByText('本地项目')).toBeInTheDocument()
    expect(screen.getByText('设备默认工作区')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-workspace-bar')).toContainElement(
      screen.getByTestId('model-selector-button')
    )
    expect(screen.getByTestId('project-chat-composer-form')).not.toContainElement(
      screen.getByTestId('model-selector-button')
    )
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ prompt: '', enabled: false }))
  })

  it('loads plugins and skills from the selected execution workspace for slash commands', async () => {
    const readCatalog = vi.fn(async () => ({
      taskId: null,
      workspacePath: '/repo',
      projectPluginIds: [],
      apps: [],
      marketplaces: [
        {
          name: 'local',
          plugins: [{ name: 'tool', enabled: true, installed: true, source: { path: '/tool' } }],
        },
      ],
      skills: [{ name: 'review', path: '/repo/review/SKILL.md' }],
      store: { storePath: '/store', plugins: [] },
      cloudInstalledPlugins: [],
    }))
    const services = {
      composerCatalogApi: { readCatalog },
      deviceApi: {},
    } as unknown as WorkbenchServices
    render(
      <Fixture
        save={vi.fn()}
        services={services}
        initial={{
          projectKey: 'repo',
          workspacePath: '/repo',
          executionMode: 'current_workspace',
        }}
      />
    )
    const editor = screen.getByTestId('stand-in-prompt') as HTMLElement & { value: string }
    act(() => {
      editor.value = '/'
      editor.focus()
    })
    expect(await screen.findByTestId('slash-command-option-app-plugin-tool')).toBeInTheDocument()
    expect(await screen.findByTestId('slash-command-option-skill-review')).toBeInTheDocument()
    expect(readCatalog).toHaveBeenCalledWith(
      { deviceId: 'mac', scope: 'workspace', workspacePath: '/repo' },
      true
    )
    await userEvent.click(screen.getByTestId('slash-command-option-skill-review'))
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(editor.value).toContain('/repo/review/SKILL.md')
  })

  it('uses shared project and execution selectors and excludes other devices', async () => {
    const save = vi.fn(async () => true)
    const user = userEvent.setup()
    render(<Fixture save={save} />)
    const bar = screen.getByTestId('stand-in-workspace-bar')
    const follows = (first: HTMLElement, second: HTMLElement) =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(bar).toContainElement(screen.getByTestId('stand-in-agent'))
    expect(
      follows(screen.getByTestId('stand-in-agent'), screen.getByTestId('stand-in-device'))
    ).toBe(true)
    expect(
      follows(screen.getByTestId('stand-in-device'), screen.getByTestId('project-work-button'))
    ).toBe(true)
    await user.click(screen.getByTestId('project-work-button'))
    expect(screen.queryByTestId('project-option-18')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('project-option-17'))
    await waitFor(() =>
      expect(screen.getByTestId('project-work-button')).toHaveTextContent('Repository')
    )
    expect(
      follows(
        screen.getByTestId('project-work-button'),
        screen.getByTestId('execution-mode-button')
      )
    ).toBe(true)
    await user.click(screen.getByTestId('execution-mode-button'))
    await user.click(screen.getByTestId('execution-mode-git-worktree-button'))
    await user.type(screen.getByTestId('stand-in-prompt'), 'Review changes')
    await user.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Review changes',
        workspace: {
          projectKey: 'repo',
          workspacePath: '/repo',
          executionMode: 'git_worktree',
        },
      })
    )
  })

  it('saves an unavailable project selection without substituting another directory', async () => {
    const save = vi.fn(async () => true)
    render(
      <Fixture
        save={save}
        initial={{
          projectKey: 'removed',
          workspacePath: '/gone',
          executionMode: 'current_workspace',
        }}
      />
    )
    expect(screen.getByTestId('stand-in-save')).toBeEnabled()
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: expect.objectContaining({ workspacePath: '/gone' }) })
    )
    expect(screen.getByTestId('stand-in-prompt')).toHaveAttribute('contenteditable', 'true')
  })
  it('uses the ordinary plus menu for Goal without offering unsupported attachment actions', async () => {
    const save = vi.fn(async () => true)
    render(<Fixture save={save} />)
    await userEvent.click(screen.getByTestId('add-context-button'))
    expect(screen.queryByTestId('attach-files-button')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('set-goal-button'))
    expect(screen.getByTestId('goal-draft-pill')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('stand-in-save'))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ goalMode: true }))
  })
  it('opens the marketplace in a separate tab while preserving the stand-in draft', async () => {
    const openTab = vi.fn()
    render(
      <WorkspaceTabsContext.Provider value={{ openTab } as unknown as WorkspaceTabsContextValue}>
        <Fixture save={vi.fn()} />
      </WorkspaceTabsContext.Provider>
    )
    const editor = screen.getByTestId('stand-in-prompt') as HTMLElement & { value: string }
    act(() => {
      editor.value = 'Keep my instructions /'
      editor.focus()
    })
    await userEvent.click(await screen.findByTestId('slash-command-option-plugin-marketplace'))
    expect(openTab).toHaveBeenCalledWith('auxiliary', { contentRoute: '/plugins' })
    expect(screen.getByTestId('stand-in-prompt')).toBe(editor)
    expect(editor.textContent).toContain('Keep my instructions')
  })
})
