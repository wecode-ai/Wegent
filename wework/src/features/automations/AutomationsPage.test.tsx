import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Automation, AutomationListResponse } from '@/types/automation'
import '@/i18n'
import { AutomationsPage, type AutomationNavigationHandle } from './AutomationsPage'

const api = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  listAutomationRuns: vi.fn().mockResolvedValue({ items: [] }),
}))
vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { devices: [], projects: [], runtimeWork: null, currentRuntimeTask: null },
    services: { automationApi: api },
    projectChat: { models: [], selectedModel: null, selectedModelOptions: null },
    refreshWorkLists: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('@/components/layout/WorkbenchSearchDialog', () => ({ WorkbenchSearchDialog: () => null }))

const saved: Automation = {
  id: 'saved-calendar',
  version: 1,
  source: 'local',
  name: 'Saved calendar',
  description: '',
  prompt: 'Existing work',
  enabled: true,
  conversationMode: 'independent',
  notificationPolicy: 'all_runs',
  schedule: { type: 'cron', expression: '0 9 * * 1-5' },
  timezone: 'Asia/Shanghai',
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
}

beforeEach(() => {
  api.listAutomations.mockReset()
  api.listAutomationRuns.mockClear()
})

it.each([false, true])(
  'preserves user selection when the initial list arrives late (discard=%s)',
  async discard => {
    let finish!: (response: AutomationListResponse) => void
    const response = new Promise<AutomationListResponse>(resolve => {
      finish = resolve
    })
    api.listAutomations.mockReturnValue(response)
    const ref = createRef<AutomationNavigationHandle>()
    const leave = vi.fn()
    const user = userEvent.setup()
    render(<AutomationsPage embedded standInOwner={{ userId: 1, roleId: '@primary' }} ref={ref} />)
    await waitFor(() => expect(api.listAutomations).toHaveBeenCalled())
    await user.click(screen.getByTestId('create-automation-button'))
    await user.type(screen.getByTestId('automation-name-input'), 'Unsaved calendar')
    if (discard) {
      await act(async () => ref.current!.requestLeave(leave))
      await user.click(screen.getByTestId('automation-discard'))
      expect(leave).toHaveBeenCalledOnce()
    }
    await act(async () => finish({ items: [saved] }))
    if (discard) expect(screen.queryByTestId('automation-name-input')).not.toBeInTheDocument()
    else expect(screen.getByTestId('automation-name-input')).toHaveValue('Unsaved calendar')
    expect(screen.getByTestId('automation-row-saved-calendar')).toBeInTheDocument()
  }
)

it('selects the first saved automation when the user has not chosen a draft', async () => {
  api.listAutomations.mockResolvedValue({ items: [saved] })
  render(<AutomationsPage embedded standInOwner={{ userId: 1, roleId: '@primary' }} />)
  expect(await screen.findByTestId('automation-name-input')).toHaveValue('Saved calendar')
})
