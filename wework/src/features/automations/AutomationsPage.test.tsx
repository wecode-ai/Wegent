import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Automation } from '@/types/automation'
import { AutomationsPage, type AutomationNavigationHandle } from './AutomationsPage'

const { listAutomations, listAutomationRuns, workbench } = vi.hoisted(() => {
  const listAutomations = vi.fn()
  const listAutomationRuns = vi.fn().mockResolvedValue({ items: [] })
  return {
    listAutomations,
    listAutomationRuns,
    workbench: {
      state: { devices: [], projects: [], runtimeWork: null, currentRuntimeTask: null },
      services: { automationApi: { listAutomations, listAutomationRuns } },
      projectChat: { models: [], selectedModel: null, selectedModelOptions: {} },
      refreshWorkLists: vi.fn(),
    },
  }
})

vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => workbench }))
vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('@/components/layout/WorkbenchSearchDialog', () => ({ WorkbenchSearchDialog: () => null }))

const savedAutomation: Automation = {
  id: 'saved-schedule',
  version: 1,
  source: 'local',
  name: '已保存的日历',
  description: '',
  prompt: '原任务说明',
  schedule: { type: 'cron', expression: '0 9 * * *' },
  timezone: 'Asia/Shanghai',
  enabled: true,
  conversationMode: 'independent',
  notificationPolicy: 'all_runs',
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
}

beforeEach(() => vi.clearAllMocks())

function holdInitialList() {
  let resolveList!: (value: { items: Automation[] }) => void
  const response = new Promise<{ items: Automation[] }>(resolve => {
    resolveList = resolve
  })
  listAutomations.mockReturnValue(response)
  return resolveList
}

test('a delayed initial list cannot replace a new draft or restore it after discard', async () => {
  const resolveList = holdInitialList()
  const onDirtyChange = vi.fn()
  const ref = createRef<AutomationNavigationHandle>()
  render(<AutomationsPage embedded ref={ref} onDirtyChange={onDirtyChange} />)
  await waitFor(() => expect(listAutomations).toHaveBeenCalled())
  fireEvent.click(screen.getByTestId('create-automation-button'))
  fireEvent.change(screen.getByTestId('automation-name-input'), { target: { value: '未保存日历' } })
  fireEvent.change(screen.getByTestId('automation-prompt-input'), {
    target: { value: '新的任务说明' },
  })

  await act(async () => resolveList({ items: [savedAutomation] }))
  expect(screen.getByTestId('automation-name-input')).toHaveValue('未保存日历')
  expect(screen.getByTestId('automation-prompt-input')).toHaveValue('新的任务说明')
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  expect(listAutomationRuns).not.toHaveBeenCalled()

  const leave = vi.fn()
  act(() => ref.current!.requestLeave(leave))
  fireEvent.click(screen.getByTestId('automation-discard'))
  expect(leave).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('automation-name-input')).not.toBeInTheDocument()
  expect(screen.getByText(savedAutomation.name)).toBeVisible()
  expect(onDirtyChange).toHaveBeenLastCalledWith(false)
})

test('a late list cannot reopen a draft that the user already discarded', async () => {
  const resolveList = holdInitialList()
  const ref = createRef<AutomationNavigationHandle>()
  render(<AutomationsPage embedded ref={ref} />)
  await waitFor(() => expect(listAutomations).toHaveBeenCalled())
  fireEvent.click(screen.getByTestId('create-automation-button'))
  fireEvent.change(screen.getByTestId('automation-name-input'), { target: { value: '未保存日历' } })
  act(() => ref.current!.requestLeave(vi.fn()))
  fireEvent.click(screen.getByTestId('automation-discard'))

  await act(async () => resolveList({ items: [savedAutomation] }))
  expect(screen.queryByTestId('automation-name-input')).not.toBeInTheDocument()
  expect(screen.getByText(savedAutomation.name)).toBeVisible()
  expect(listAutomationRuns).not.toHaveBeenCalled()
})

test('selects the first saved automation when the user has not chosen another view', async () => {
  listAutomations.mockResolvedValue({ items: [savedAutomation] })
  const onDirtyChange = vi.fn()
  render(<AutomationsPage embedded onDirtyChange={onDirtyChange} />)

  await waitFor(() =>
    expect(screen.getByTestId('automation-name-input')).toHaveValue(savedAutomation.name)
  )
  expect(screen.getByTestId('automation-prompt-input')).toHaveValue(savedAutomation.prompt)
  expect(onDirtyChange).toHaveBeenLastCalledWith(false)
})
