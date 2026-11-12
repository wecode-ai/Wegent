import type { AutomationDraft } from '@/features/automations/automationDraft'
import type { DeviceInfo } from '@/types/api'
import type { Automation } from '@/types/automation'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
  listAutomations: vi.fn().mockResolvedValue({ items: [automation] }),
  listAutomationRuns: vi.fn().mockResolvedValue({ items: [] }),
  updateAutomation: vi.fn(),
}
const setRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)
let automationDetailProps: {
  draft: AutomationDraft
  devices: DeviceInfo[]
  cloudAvailable: boolean
  onChange: (key: string, value: string) => void
  onClose: () => void
  onSave: () => void
  onSourceChange: (source: 'local' | 'cloud') => void
} | null = null

const workbenchMock = {
  state: {
    user: { id: 1, user_name: 'alice', preferences: {} },
    projects: [],
    devices: [] as DeviceInfo[],
    runtimeWork: { projects: [], chats: [], totalTasks: 0 },
    currentProject: null,
    currentRuntimeTask: null,
    standaloneDeviceId: null,
    standaloneWorkspacePath: null,
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

vi.mock('@/features/automations/AutomationDetailWorkspace', () => ({
  AutomationDetailWorkspace: (props: NonNullable<typeof automationDetailProps>) => {
    automationDetailProps = props
    return (
      <section data-testid="automation-detail-panel">
        <button
          type="button"
          data-testid="automation-test-edit"
          onClick={() => props.onChange('prompt', 'Unsaved arrangement')}
        >
          Edit
        </button>
        <button type="button" data-testid="automation-detail-close" onClick={props.onClose}>
          Close
        </button>
        <button type="button" data-testid="automation-detail-save" onClick={props.onSave}>
          Save
        </button>
      </section>
    )
  },
}))

describe('AutomationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    automationApi.listAutomations.mockResolvedValue({ items: [automation] })
    automationApi.listAutomationRuns.mockResolvedValue({ items: [] })
    workbenchMock.state.defaultTeam = null
    workbenchMock.state.devices = []
    automationDetailProps = null
  })

  test('protects arrangement drafts when creating, selecting or closing details', async () => {
    render(<AutomationsPage embedded />)
    await screen.findByTestId('automation-test-edit')
    fireEvent.click(screen.getByTestId('automation-test-edit'))
    fireEvent.click(screen.getByTestId('create-automation-button'))
    expect(screen.getByTestId('automation-discard')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automation-keep-editing'))
    expect(automationDetailProps?.draft.prompt).toBe('Unsaved arrangement')
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
      fireEvent.click(screen.getByTestId('automation-detail-save'))
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
})
