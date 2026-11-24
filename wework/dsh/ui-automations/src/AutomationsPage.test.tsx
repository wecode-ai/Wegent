import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import type { Automation, AutomationMutation } from '@/types/automation'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AutomationsPage } from './AutomationsPage'

const automation: Automation = {
  id: 'local:daily-reminder',
  version: 1,
  source: 'local',
  name: 'Daily reminder',
  description: '',
  prompt: 'Say hello',
  schedule: { type: 'cron', expression: '0 9 * * *' },
  timezone: 'Asia/Shanghai',
  enabled: true,
  conversationMode: 'independent',
  notificationPolicy: 'all_runs',
  taskPayload: {},
  createdAt: '2026-08-09T00:00:00Z',
  updatedAt: '2026-08-09T00:00:00Z',
}

const automationApi = {
  createAutomation: vi.fn(),
  listAutomations: vi.fn().mockResolvedValue({ items: [automation] }),
  listAutomationRuns: vi.fn().mockResolvedValue({ items: [] }),
  updateAutomation: vi.fn(),
}
const setRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)
const workbenchMock = {
  state: {
    user: { id: 1, user_name: 'alice', preferences: {} },
    projects: [],
    devices: [] as DeviceInfo[],
    runtimeWork: null as RuntimeWorkListResponse | null,
    currentProject: null,
    currentRuntimeTask: null,
    standaloneDeviceId: null as string | null,
    standaloneWorkspacePath: null as string | null,
    defaultTeam: null,
  },
  services: { automationApi },
  projectChat: {
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
  },
  cloudWorkStatus: null,
  refreshWorkLists: vi.fn().mockResolvedValue(undefined),
  setRuntimeTaskPinned,
}

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchMock,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => false,
}))

vi.mock('@/components/layout/useDesktopSidebarCollapsed', () => ({
  useDesktopSidebarCollapsed: () => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
  }),
}))

vi.mock('@/components/layout/DesktopSidebar', () => ({
  DesktopSidebar: () => {
    return <aside data-testid="desktop-sidebar" />
  },
}))

vi.mock('@/components/layout/WorkbenchSearchDialog', () => ({
  WorkbenchSearchDialog: () => null,
}))

describe('AutomationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    automationApi.listAutomations.mockResolvedValue({ items: [automation] })
    automationApi.listAutomationRuns.mockResolvedValue({ items: [] })
    workbenchMock.state.defaultTeam = null
    workbenchMock.state.devices = []
    workbenchMock.state.runtimeWork = null
    workbenchMock.state.standaloneDeviceId = null
    workbenchMock.state.standaloneWorkspacePath = null
  })

  test('protects arrangement drafts when creating, selecting or closing details', async () => {
    render(<AutomationsPage embedded />)
    const prompt = await screen.findByTestId('automation-prompt-input')
    fireEvent.change(prompt, { target: { value: 'Unsaved arrangement' } })
    fireEvent.click(screen.getByTestId('create-automation-button'))
    expect(screen.getByTestId('automation-discard')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automation-keep-editing'))
    expect(prompt).toHaveValue('Unsaved arrangement')
    fireEvent.click(screen.getByTestId(`automation-open-${automation.id}`))
    expect(screen.getByTestId('automation-discard')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automation-keep-editing'))
    fireEvent.click(screen.getByTestId('automation-detail-close'))
    expect(screen.getByTestId('automation-discard')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automation-discard'))
    expect(screen.queryByTestId('automation-detail-panel')).not.toBeInTheDocument()
    expect(automationApi.updateAutomation).not.toHaveBeenCalled()
  })

  test('preserves the selected cloud model for scheduled thread continuations', async () => {
    vi.useFakeTimers()
    const continuationAutomation: Automation = {
      ...automation,
      conversationMode: 'continue_thread',
      taskPayload: {
        deviceId: 'local-device',
        modelId: 'public:desktop-e2e-public-upstream-model',
        modelType: 'public',
        modelOptions: {
          reasoningEffort: 'medium',
          weworkCloudModelNamespace: 'default',
          weworkCloudModelResourceUserId: '0',
        },
      },
      continuationPayload: {
        address: {
          deviceId: 'local-device',
          taskId: 'automation-task',
          workspacePath: '/workspace',
        },
        message: automation.prompt,
      },
    }
    try {
      workbenchMock.state.defaultTeam = { id: 1 }
      automationApi.listAutomations.mockResolvedValue({ items: [continuationAutomation] })
      automationApi.updateAutomation.mockResolvedValue({
        automation: continuationAutomation,
      })

      render(<AutomationsPage />)
      await act(() => vi.advanceTimersByTimeAsync(0))
      fireEvent.change(screen.getByTestId('automation-prompt-input'), {
        target: { value: 'Continue the scheduled task' },
      })
      fireEvent.click(screen.getByTestId('automation-save-button'))
      await act(() => vi.advanceTimersByTimeAsync(0))

      expect(automationApi.updateAutomation).toHaveBeenCalledWith(
        continuationAutomation.id,
        expect.objectContaining({
          continuationPayload: expect.objectContaining({
            modelId: 'public:desktop-e2e-public-upstream-model',
            modelType: 'public',
            modelOptions: {
              reasoningEffort: 'medium',
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: '0',
            },
          }),
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([20, undefined])('round-trips a cloud worktree with ID %s', async id => {
    const deviceId = 'cloud-device'
    const projectKey = 'release-project'
    const worktreePath = '/worktrees/stable'
    const binding = {
      runtimeProjectKey: projectKey,
      ...(id == null ? { workspacePath: worktreePath } : { deviceWorkspaceId: id }),
    }
    const rootWorkspace = {
      id: 19,
      deviceId,
      available: true,
      tasks: [],
      workspacePath: '/workspace/release',
    }
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: projectKey, name: 'Release', source: 'local_project' },
          deviceWorkspaces: [
            rootWorkspace,
            {
              ...rootWorkspace,
              id,
              workspacePath: worktreePath,
              workspaceKind: 'worktree',
              label: 'stable branch',
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    workbenchMock.state.runtimeWork = runtimeWork
    workbenchMock.state.devices = [
      {
        id: 1,
        device_id: deviceId,
        name: 'Cloud executor',
        device_type: 'cloud',
        status: 'online',
        bind_shell: 'claudecode',
        executor_version: '9.0.0',
        is_default: false,
      },
    ]
    let saved: Automation = {
      ...automation,
      source: 'cloud',
      taskRequest: {
        deviceId,
        standaloneChatWorkspace: true,
        runtime: 'codex',
        message: automation.prompt,
      },
    }
    automationApi.listAutomations.mockImplementation(async () => ({ items: [saved] }))
    automationApi.updateAutomation.mockImplementation(async (_id, mutation: AutomationMutation) => {
      saved = { ...saved, ...mutation, id: saved.id, version: saved.version + 1 }
      return { automation: saved }
    })

    const selectProject = () => screen.getByTestId('automation-project-select')
    const chooseProject = async (name: RegExp) => {
      await act(async () => {
        fireEvent.click(selectProject())
      })
      const menu = within(screen.getByTestId('automation-project-select-menu'))
      fireEvent.click(menu.getByRole('option', { name }))
    }
    const save = async () => {
      await act(async () => {
        fireEvent.click(screen.getByTestId('automation-save-button'))
      })
      expect(screen.queryByTestId('automation-save-button')).toBeNull()
    }
    const view = render(<AutomationsPage embedded />)
    await act(() => Promise.resolve())
    await chooseProject(/stable branch/)
    await save()
    expect(saved.taskRequest).toMatchObject(binding)
    expect(selectProject()).toHaveTextContent('stable branch')
    view.unmount()

    workbenchMock.state.runtimeWork = null
    const reopened = render(<AutomationsPage embedded />)
    await act(() => Promise.resolve())
    expect(selectProject()).toHaveTextContent('Release')
    fireEvent.change(screen.getByTestId('automation-prompt-input'), {
      target: { value: 'Review the release notes' },
    })
    await save()
    expect(saved.taskRequest).toMatchObject(binding)

    workbenchMock.state.runtimeWork = runtimeWork
    reopened.rerender(<AutomationsPage embedded />)
    expect(selectProject()).toHaveTextContent('stable branch')
    await chooseProject(/^(None|无)$/)
    await save()
    expect(saved.taskRequest).toMatchObject({ standaloneChatWorkspace: true })
    expect(saved.taskRequest).not.toHaveProperty('runtimeProjectKey')
    expect(selectProject()).toHaveAttribute('data-value', '')
  })

  test('binds the inherited workspace when the project list loads after the draft opens', async () => {
    const deviceId = 'local-device'
    const workspacePath = '/workspace/inherited'
    workbenchMock.state.devices = [
      {
        id: 1,
        device_id: deviceId,
        name: 'Local executor',
        device_type: 'local',
        status: 'online',
        bind_shell: 'claudecode',
        executor_version: '9.0.0',
        is_default: false,
      },
    ]
    workbenchMock.state.standaloneDeviceId = deviceId
    workbenchMock.state.standaloneWorkspacePath = workspacePath
    automationApi.listAutomations.mockResolvedValue({ items: [] })
    automationApi.createAutomation.mockResolvedValue({ automation })

    const view = render(<AutomationsPage embedded />)
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByTestId('create-automation-button'))
    const projectPicker = screen.getByTestId('automation-project-select')
    expect(projectPicker).toHaveTextContent(workspacePath)

    workbenchMock.state.runtimeWork = {
      projects: [
        {
          project: { key: 'inherited', name: 'Inherited project', source: 'local_project' },
          deviceWorkspaces: [{ id: 19, deviceId, available: true, tasks: [], workspacePath }],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    view.rerender(<AutomationsPage embedded />)
    expect(projectPicker).toHaveTextContent('Inherited project')
    fireEvent.change(screen.getByTestId('automation-name-input'), { target: { value: 'Review' } })
    fireEvent.change(screen.getByTestId('automation-prompt-input'), {
      target: { value: 'Review the linked project' },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-save-button'))
    })
    expect(automationApi.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRequest: expect.objectContaining({
          runtimeProjectKey: 'inherited',
          deviceWorkspaceId: 19,
        }),
      })
    )
  })
})
