import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { PluginCreateWorkspace } from './PluginCreateWorkspace'
import type { InstalledPlugin } from '@/types/api'

const localPluginMocks = vi.hoisted(() => ({
  listInstalledPlugins: vi.fn(),
  getAccess: vi.fn(),
  createApi: vi.fn(),
  cloud: {
    apiBaseUrl: 'https://cloud.example.com/api',
    token: 'owner-token',
    user: { id: 1 },
  },
}))
vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    listInstalledPlugins: localPluginMocks.listInstalledPlugins,
  }),
}))
vi.mock('./workspace/marketplaceWorkspaceHelpers', () => ({
  createDefaultPluginApi: localPluginMocks.createApi,
}))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => localPluginMocks.cloud,
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: vi.fn(),
}))

function createWorkbench() {
  const sendCurrentInput = vi.fn().mockResolvedValue(true)
  const setSelectedSkills = vi.fn()
  const handleFileSelect = vi.fn().mockResolvedValue(undefined)
  const resetAttachments = vi.fn()
  const startNewChat = vi.fn()

  return {
    sendCurrentInput,
    setSelectedSkills,
    handleFileSelect,
    resetAttachments,
    startNewChat,
    value: {
      state: {
        projects: [],
        devices: [],
        runtimeWork: null,
        currentProject: null,
        currentRuntimeTask: {
          deviceId: 'local-device',
          taskId: 'existing-task',
          workspacePath: '/Users/test/workspace',
        },
        selectedDeviceWorkspaceId: null,
        pendingProjectWorkspaceProjectId: null,
        standaloneDeviceId: 'local-device',
        standaloneWorkspacePath: '/Users/test/workspace',
        error: null,
      },
      workspaceFileApi: {
        listWorkspaceEntries: vi.fn(),
        readWorkspaceTextFile: vi.fn(),
      },
      projectChat: {
        models: [],
        skills: [],
        selectedModel: null,
        selectedModelOptions: {},
        isModelSelectionReady: true,
        trialTemplates: [],
        selectedSkills: [],
        attachments: [],
        uploadingFiles: new Map(),
        errors: new Map(),
        isOptionsLocked: true,
        isAttachmentReadyToSend: true,
        setSelectedModel: vi.fn(),
        setSelectedModelOption: vi.fn(),
        onBlockedModelSelect: vi.fn(),
        setInput: vi.fn(),
        setSelectedSkills,
        toggleSkill: vi.fn(),
        handleFileSelect,
        addExistingAttachment: vi.fn(),
        removeAttachment: vi.fn(),
        resetAttachments,
        listLocalSkills: vi.fn().mockResolvedValue([]),
        listLocalApps: vi.fn().mockResolvedValue([]),
      },
      projectExecutionMode: 'current_workspace',
      setProjectExecutionMode: vi.fn(),
      projectWorktreeBranch: null,
      setProjectWorktreeBranch: vi.fn(),
      selectProject: vi.fn(),
      selectProjectWorkspace: vi.fn(),
      selectStandaloneDevice: vi.fn(),
      sendCurrentInput,
      startNewChat,
    } as unknown as ReturnType<typeof useWorkbench>,
  }
}

function editableSource(
  sourcePayload: InstalledPlugin['spec']['sourcePayload'] = null
): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'shared-plugin' },
    spec: {
      source: { type: 'local', pluginKey: 'shared-plugin', providerKey: 'wework-personal' },
      origin: 'created',
      displayName: 'Shared Plugin',
      description: '',
      enabled: true,
      installState: 'installed',
      manifest: {},
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      sourcePayload,
    },
    status: { state: 'installed' },
  }
}

describe('PluginCreateWorkspace', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/plugins/create')
    localPluginMocks.listInstalledPlugins.mockReset()
    localPluginMocks.getAccess.mockReset()
    localPluginMocks.createApi.mockReset()
    localPluginMocks.createApi.mockReturnValue({
      getMarketplacePluginAccess: localPluginMocks.getAccess,
    })
    localPluginMocks.cloud = {
      apiBaseUrl: 'https://cloud.example.com/api',
      token: 'owner-token',
      user: { id: 1 },
    }
  })

  test.each([false, true])(
    'checks fresh source identity before a direct edit URL dispatch (managed=%s)',
    async managed => {
      window.history.replaceState({}, '', '/plugins/create?edit=shared-plugin')
      const workbench = createWorkbench()
      vi.mocked(useWorkbench).mockReturnValue(workbench.value)
      const source = editableSource(managed ? { managedByWegent: true, cloudPluginId: 42 } : null)
      localPluginMocks.listInstalledPlugins.mockResolvedValue({ items: [source] })
      render(<PluginCreateWorkspace />)
      fireEvent.change(screen.getByTestId('plugin-create-prompt-input'), {
        target: { value: 'Update scheduling' },
      })
      await userEvent.click(screen.getByTestId('plugin-create-submit-button'))
      expect(localPluginMocks.listInstalledPlugins).toHaveBeenCalledWith({
        requireComplete: true,
        refresh: true,
      })
      if (managed) {
        expect(
          await screen.findByText('只能编辑自己创建或复制的个人插件，请先复制为我的插件。')
        ).toBeInTheDocument()
        expect(workbench.sendCurrentInput).not.toHaveBeenCalled()
      } else {
        await waitFor(() =>
          expect(workbench.sendCurrentInput).toHaveBeenCalledWith(
            expect.stringContaining('continue editing the plugin "shared-plugin"'),
            expect.anything()
          )
        )
      }
      expect(localPluginMocks.getAccess).not.toHaveBeenCalled()
    }
  )

  test.each(['owner', 'recipient', 'unavailable'] as const)(
    'checks current cloud ownership before editing a linked local source: %s',
    async role => {
      window.history.replaceState({}, '', '/plugins/create?edit=shared-plugin')
      const workbench = createWorkbench()
      vi.mocked(useWorkbench).mockReturnValue(workbench.value)
      localPluginMocks.listInstalledPlugins.mockResolvedValue({
        items: [editableSource({ cloudPluginId: 42, cloudReleaseId: 8 })],
      })
      const failure = role === 'recipient' ? 'Plugin not found' : 'Cloud access unavailable'
      if (role === 'owner') localPluginMocks.getAccess.mockResolvedValue({ pluginId: 42 })
      else localPluginMocks.getAccess.mockRejectedValue(new Error(failure))
      render(<PluginCreateWorkspace />)
      fireEvent.change(screen.getByTestId('plugin-create-prompt-input'), {
        target: { value: 'Update scheduling' },
      })
      await userEvent.click(screen.getByTestId('plugin-create-submit-button'))

      expect(localPluginMocks.createApi).toHaveBeenCalledWith(
        'https://cloud.example.com/api',
        'owner-token'
      )
      expect(localPluginMocks.getAccess).toHaveBeenCalledExactlyOnceWith(42)
      if (role === 'owner') {
        await waitFor(() => expect(workbench.sendCurrentInput).toHaveBeenCalledOnce())
      } else {
        expect(await screen.findByText(failure)).toBeInTheDocument()
        expect(workbench.sendCurrentInput).not.toHaveBeenCalled()
        expect(workbench.setSelectedSkills).not.toHaveBeenCalled()
      }
    }
  )

  test.each(['inventory', 'access'] as const)(
    'ignores ownership approval from a previous account while reading %s',
    async phase => {
      window.history.replaceState({}, '', '/plugins/create?edit=shared-plugin')
      const workbench = createWorkbench()
      vi.mocked(useWorkbench).mockReturnValue(workbench.value)
      let approve!: () => void
      const pending = new Promise<void>(resolve => {
        approve = resolve
      })
      localPluginMocks.listInstalledPlugins.mockImplementation(async () => {
        if (phase === 'inventory') await pending
        return { items: [editableSource({ cloudPluginId: 42, cloudReleaseId: 8 })] }
      })
      localPluginMocks.getAccess.mockImplementation(async () => {
        if (phase === 'access') await pending
        return { pluginId: 42 }
      })
      const { rerender } = render(<PluginCreateWorkspace />)
      fireEvent.change(screen.getByTestId('plugin-create-prompt-input'), {
        target: { value: 'Update scheduling' },
      })
      await userEvent.click(screen.getByTestId('plugin-create-submit-button'))
      await waitFor(() =>
        expect(
          phase === 'inventory' ? localPluginMocks.listInstalledPlugins : localPluginMocks.getAccess
        ).toHaveBeenCalled()
      )

      localPluginMocks.cloud = {
        ...localPluginMocks.cloud,
        token: 'recipient-token',
        user: { id: 2 },
      }
      rerender(<PluginCreateWorkspace />)
      await act(async () => {
        approve()
        await pending
      })

      expect(workbench.sendCurrentInput).not.toHaveBeenCalled()
      expect(screen.getByTestId('plugin-create-submit-button')).toBeEnabled()
    }
  )

  test('does not dispatch a linked edit after the workspace unmounts during ownership checks', async () => {
    window.history.replaceState({}, '', '/plugins/create?edit=shared-plugin')
    const workbench = createWorkbench()
    vi.mocked(useWorkbench).mockReturnValue(workbench.value)
    let approve!: () => void
    const pending = new Promise<void>(resolve => {
      approve = resolve
    })
    localPluginMocks.listInstalledPlugins.mockResolvedValue({
      items: [editableSource({ cloudPluginId: 42, cloudReleaseId: 8 })],
    })
    localPluginMocks.getAccess.mockImplementation(async () => {
      await pending
      return { pluginId: 42 }
    })
    const { unmount } = render(<PluginCreateWorkspace />)
    fireEvent.change(screen.getByTestId('plugin-create-prompt-input'), {
      target: { value: 'Update scheduling' },
    })
    await userEvent.click(screen.getByTestId('plugin-create-submit-button'))
    await waitFor(() => expect(localPluginMocks.getAccess).toHaveBeenCalled())
    unmount()
    await act(async () => {
      approve()
      await pending
    })

    expect(workbench.sendCurrentInput).not.toHaveBeenCalled()
  })

  test.each(['Source inventory unavailable', 'Store unavailable', 'Cloud links unavailable'])(
    'does not dispatch an edit task when source provenance fails: %s',
    async failure => {
      window.history.replaceState({}, '', '/plugins/create?edit=shared-plugin')
      const workbench = createWorkbench()
      vi.mocked(useWorkbench).mockReturnValue(workbench.value)
      localPluginMocks.listInstalledPlugins.mockRejectedValue(new Error(failure))
      render(<PluginCreateWorkspace />)
      fireEvent.change(screen.getByTestId('plugin-create-prompt-input'), {
        target: { value: 'Update scheduling' },
      })
      await userEvent.click(screen.getByTestId('plugin-create-submit-button'))
      expect(await screen.findByText(failure)).toBeInTheDocument()
      expect(workbench.sendCurrentInput).not.toHaveBeenCalled()
    }
  )

  test('reuses the empty task launcher layout with an inline Plugin Creator context', async () => {
    const workbench = createWorkbench()
    vi.mocked(useWorkbench).mockReturnValue(workbench.value)

    render(<PluginCreateWorkspace />)

    expect(screen.getByTestId('plugin-create-workspace')).toHaveClass('overflow-hidden')
    expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '我们该做什么？' })).toBeInTheDocument()
    expect(await screen.findByTestId('task-suggestion-categories')).toBeInTheDocument()
    expect(screen.getByTestId('project-chat-composer')).toBeInTheDocument()
    expect(screen.getByTestId('composer-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-create-prompt-input')).toBeInTheDocument()

    const creatorContext = screen.getByTestId('plugin-creator-context')
    expect(creatorContext).toHaveTextContent('Plugin Creator')
    expect(creatorContext).toHaveClass('plugin-creator-context', 'px-0.5', 'font-medium')
    expect(creatorContext).not.toHaveClass('rounded-md', 'border', 'bg-focus/10')
    expect(creatorContext.querySelector('svg')).toHaveClass('h-4', 'w-4')
    expect(screen.getByTestId('composer-input-leading-context')).toContainElement(creatorContext)
    expect(screen.getByTestId('composer-toolbar')).not.toContainElement(creatorContext)
    expect(screen.getByTestId('plugin-create-submit-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('plugin-creator-context-dismiss'))
    expect(workbench.startNewChat).toHaveBeenCalled()
    expect(workbench.setSelectedSkills).toHaveBeenCalledWith([])
    expect(window.location.pathname).toBe('/')
  })

  test('keeps desktop composer attachment and model controls', async () => {
    const workbench = createWorkbench()
    vi.mocked(useWorkbench).mockReturnValue(workbench.value)

    render(<PluginCreateWorkspace />)

    const attachment = new File(['context'], 'requirements.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('attachment-file-input'), {
      target: { files: [attachment] },
    })
    expect(workbench.handleFileSelect).toHaveBeenCalledWith([attachment])

    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('dismisses plugin creator with backspace on an empty composer back to new task', async () => {
    const workbench = createWorkbench()
    vi.mocked(useWorkbench).mockReturnValue(workbench.value)

    render(<PluginCreateWorkspace />)

    const editor = screen.getByTestId('plugin-create-prompt-input')
    editor.focus()
    fireEvent.keyDown(editor, { key: 'Backspace' })

    expect(workbench.startNewChat).toHaveBeenCalled()
    expect(window.location.pathname).toBe('/')
  })

  test('starts a new plugin creator task instead of continuing the active conversation', async () => {
    const workbench = createWorkbench()
    vi.mocked(useWorkbench).mockReturnValue(workbench.value)

    render(<PluginCreateWorkspace />)

    fireEvent.change(screen.getByTestId('plugin-create-prompt-input'), {
      target: { value: 'Create a release-notes plugin' },
    })
    await userEvent.click(screen.getByTestId('plugin-create-submit-button'))

    expect(workbench.setSelectedSkills).toHaveBeenCalledWith([
      {
        name: 'wework-plugin-creator',
        namespace: 'codex',
        is_public: false,
      },
    ])
    await waitFor(() =>
      expect(workbench.sendCurrentInput).toHaveBeenCalledWith(
        expect.stringMatching(
          /DEVICE_TYPE=cloud[\s\S]*\$WEGENT_TASK_WORKSPACE\/plugins\/<plugin-name>[\s\S]*registered managed local marketplace named "wework-personal"[\s\S]*do not use the defaults under ~\/plugins or ~\/\.agents[\s\S]*plugin-workspace describe[\s\S]*Create a release-notes plugin/
        ),
        expect.objectContaining({
          forceNewTask: true,
          additionalSkills: [
            {
              name: 'wework-plugin-creator',
              namespace: 'codex',
              is_public: false,
            },
          ],
          onError: expect.any(Function),
        })
      )
    )
    expect(window.location.pathname).toBe('/')
  })
})
