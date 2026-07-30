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

  return {
    sendCurrentInput,
    setSelectedSkills,
    handleFileSelect,
    resetAttachments,
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
    } as unknown as ReturnType<typeof useWorkbench>,
  }
}

describe('PluginCreateWorkspace', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/plugins/create')
  })

  test('reuses the desktop chat composer and its interactive controls', async () => {
    const workbench = createWorkbench()
    vi.mocked(useWorkbench).mockReturnValue(workbench.value)

    render(<PluginCreateWorkspace />)

    expect(screen.getByTestId('project-chat-composer')).toBeInTheDocument()
    expect(screen.getByTestId('composer-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-creator-context')).toHaveTextContent('Plugin Creator')
    expect(screen.getByTestId('plugin-create-submit-button')).toBeDisabled()

    const attachment = new File(['context'], 'requirements.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('attachment-file-input'), {
      target: { files: [attachment] },
    })
    expect(workbench.handleFileSelect).toHaveBeenCalledWith([attachment])

    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
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
        expect.stringContaining('Create a release-notes plugin'),
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
