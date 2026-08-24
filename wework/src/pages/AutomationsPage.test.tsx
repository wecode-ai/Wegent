import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Automation } from '@/types/automation'
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

const workbenchMock = {
  state: {
    user: { id: 1, user_name: 'alice', preferences: {} },
    projects: [],
    devices: [],
    runtimeWork: { projects: [], chats: [], totalTasks: 0 },
    currentProject: null,
    currentRuntimeTask: null,
    standaloneDeviceId: null,
    standaloneWorkspacePath: null,
  },
  services: { automationApi },
  projectChat: {
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
  },
  cloudWorkStatus: null,
  refreshWorkLists: vi.fn().mockResolvedValue(undefined),
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
  isTauriRuntime: () => false,
}))

vi.mock('@/components/layout/useDesktopSidebarCollapsed', () => ({
  useDesktopSidebarCollapsed: () => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
  }),
}))

vi.mock('@/components/layout/DesktopSidebar', () => ({
  DesktopSidebar: () => <aside data-testid="desktop-sidebar" />,
}))

vi.mock('@/components/layout/WorkbenchSearchDialog', () => ({
  WorkbenchSearchDialog: () => null,
}))

vi.mock('@/features/automations/AutomationDetailWorkspace', () => ({
  AutomationDetailWorkspace: ({ onClose, onSave }: { onClose: () => void; onSave: () => void }) => (
    <section data-testid="automation-detail-panel">
      <button type="button" data-testid="automation-detail-close" onClick={onClose}>
        Close
      </button>
      <button type="button" data-testid="automation-detail-save" onClick={onSave}>
        Save
      </button>
    </section>
  ),
}))

describe('AutomationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    automationApi.listAutomations.mockResolvedValue({ items: [automation] })
    automationApi.listAutomationRuns.mockResolvedValue({ items: [] })
  })

  test('keeps the detail panel closed after the user dismisses it', async () => {
    vi.useFakeTimers()
    try {
      render(<AutomationsPage />)
      await act(() => vi.advanceTimersByTimeAsync(0))

      expect(screen.getByTestId('automation-detail-panel')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('automation-detail-close'))

      expect(screen.queryByTestId('automation-detail-panel')).not.toBeInTheDocument()
      expect(screen.getByTestId('automation-list-pane')).toHaveClass('flex-1')
      expect(screen.queryByText('选择一个任务查看详情')).not.toBeInTheDocument()
      expect(automationApi.listAutomations).toHaveBeenCalledTimes(1)

      await act(() => vi.advanceTimersByTimeAsync(30_000))

      expect(automationApi.listAutomations).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('automation-detail-panel')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
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
