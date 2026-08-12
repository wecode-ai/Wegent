import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { PluginCreateWorkspace } from './PluginCreateWorkspace'

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

describe('PluginCreateWorkspace', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/plugins/create')
  })

  test('reuses the empty task launcher layout with a dismissible Plugin Creator chip', async () => {
    const workbench = createWorkbench()
    vi.mocked(useWorkbench).mockReturnValue(workbench.value)

    render(<PluginCreateWorkspace />)

    expect(screen.getByTestId('plugin-create-workspace')).toHaveClass('overflow-hidden')
    expect(screen.getByTestId('desktop-empty-composer-frame')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '我们该做什么？' })).toBeInTheDocument()
    expect(screen.getByTestId('task-suggestion-categories')).toBeInTheDocument()
    expect(screen.getByTestId('project-chat-composer')).toBeInTheDocument()
    expect(screen.getByTestId('composer-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-create-prompt-input')).toBeInTheDocument()

    const creatorContext = screen.getByTestId('plugin-creator-context')
    expect(creatorContext).toHaveTextContent('Plugin Creator')
    expect(creatorContext).toHaveClass('text-focus')
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

    await userEvent.type(
      screen.getByTestId('plugin-create-prompt-input'),
      'Create a release-notes plugin'
    )
    await userEvent.click(screen.getByTestId('plugin-create-submit-button'))

    expect(workbench.setSelectedSkills).toHaveBeenCalledWith([
      {
        name: 'plugin-creator',
        namespace: 'codex',
        is_public: false,
      },
    ])
    await waitFor(() =>
      expect(workbench.sendCurrentInput).toHaveBeenCalledWith(
        expect.stringMatching(
          /registered managed local marketplace named "wework-personal"[\s\S]*Do not use the Plugin Creator defaults under ~\/plugins or ~\/\.agents[\s\S]*Create a release-notes plugin/
        ),
        expect.objectContaining({
          forceNewTask: true,
          additionalSkills: [
            {
              name: 'plugin-creator',
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
