import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Automation } from '@/types/automation'
import { AutomationsPage, type AutomationNavigationHandle } from './AutomationsPage'

const { listAutomations, listAutomationRuns, updateAutomation, viewport, workbench } = vi.hoisted(
  () => {
    const listAutomations = vi.fn()
    const listAutomationRuns = vi.fn().mockResolvedValue({ items: [] })
    const updateAutomation = vi.fn()
    return {
      listAutomations,
      listAutomationRuns,
      updateAutomation,
      viewport: { isMobile: false },
      workbench: {
        state: { devices: [], projects: [], runtimeWork: null, currentRuntimeTask: null },
        services: { automationApi: { listAutomations, listAutomationRuns, updateAutomation } },
        projectChat: { models: [], selectedModel: null, selectedModelOptions: {} },
        refreshWorkLists: vi.fn(),
      },
    }
  }
)

vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => workbench }))
vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('@/components/layout/WorkbenchSearchDialog', () => ({ WorkbenchSearchDialog: () => null }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => viewport.isMobile }))

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

beforeEach(() => {
  vi.clearAllMocks()
  updateAutomation.mockReset()
  viewport.isMobile = false
})

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

test('opens the requested stand-in schedule rather than selecting the first item', async () => {
  const owner = { userId: 7, roleId: '@primary' }
  const first = {
    ...savedAutomation,
    id: 'first',
    taskRequest: { standInOwner: owner, standInCalendar: {} },
  }
  const requested = { ...first, id: 'requested', name: '选中的安排' }
  listAutomations.mockResolvedValue({ items: [first, requested] })
  render(<AutomationsPage embedded standInOwner={owner} initialAutomationId="requested" />)
  await waitFor(() => expect(screen.getByTestId('automation-name-input')).toHaveValue('选中的安排'))
  expect(screen.getByTestId('automation-prompt-input')).toHaveValue(savedAutomation.prompt)
})

test('cannot select a schedule belonging to a different stand-in role', async () => {
  listAutomations.mockResolvedValue({
    items: [
      {
        ...savedAutomation,
        taskRequest: { standInOwner: { userId: 8, roleId: '@primary' }, standInCalendar: {} },
      },
    ],
  })
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: '@primary' }}
      initialAutomationId={savedAutomation.id}
    />
  )
  await waitFor(() =>
    expect(screen.queryByTestId('automation-list-loading')).not.toBeInTheDocument()
  )
  expect(screen.queryByTestId('automation-name-input')).not.toBeInTheDocument()
  expect(screen.queryByText(savedAutomation.name)).not.toBeInTheDocument()
})

test('detail-only mode does not expose a list or create action for an unavailable schedule', async () => {
  listAutomations.mockResolvedValue({ items: [] })
  render(
    <AutomationsPage
      embedded
      detailOnly
      standInOwner={{ userId: 7, roleId: '@primary' }}
      initialAutomationId="missing"
    />
  )
  expect(await screen.findByTestId('automation-detail-status')).toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByTestId('automation-detail-status')).toHaveAttribute('role', 'alert')
  )
  expect(screen.queryByTestId('create-automation-button')).not.toBeInTheDocument()
  expect(screen.queryByTestId('automation-name-input')).not.toBeInTheDocument()
})

test.each([
  { mode: 'detail-only', calendar: true, detailOnly: true, mobile: false },
  { mode: 'stand-in', calendar: true, detailOnly: false, mobile: false },
  { mode: 'ordinary desktop', calendar: false, detailOnly: false, mobile: false },
  { mode: 'ordinary mobile', calendar: false, detailOnly: false, mobile: true },
])(
  '$mode editor shows failed saves and preserves the draft for retry',
  async ({ calendar, detailOnly, mobile }) => {
    viewport.isMobile = mobile
    const owner = { userId: 7, roleId: '@primary' }
    const automation: Automation = {
      ...savedAutomation,
      taskRequest: {
        schemaVersion: 2,
        runtime: 'codex',
        deviceId: 'local',
        message: savedAutomation.prompt,
        ...(calendar ? { standInOwner: owner, standInCalendar: {} } : {}),
      },
    }
    const onDirtyChange = vi.fn()
    listAutomations.mockResolvedValue({ items: [automation] })
    updateAutomation
      .mockRejectedValueOnce(new Error('安排版本已变更，请重新加载'))
      .mockResolvedValueOnce({
        automation: { ...automation, name: '保留修改', prompt: '保留任务说明' },
      })
    render(
      <AutomationsPage
        embedded
        detailOnly={detailOnly}
        standInOwner={calendar ? owner : undefined}
        initialAutomationId={savedAutomation.id}
        onDirtyChange={onDirtyChange}
      />
    )
    const name = await screen.findByTestId('automation-name-input')
    const prompt = screen.getByTestId('automation-prompt-input')
    fireEvent.change(name, { target: { value: '保留修改' } })
    fireEvent.change(prompt, { target: { value: '保留任务说明' } })
    fireEvent.click(screen.getByTestId('automation-save-button'))
    const error = await screen.findByTestId('automation-draft-error')
    expect(error).toBeVisible()
    expect(error).toHaveTextContent('安排版本已变更，请重新加载')
    expect(name).toHaveValue('保留修改')
    expect(prompt).toHaveValue('保留任务说明')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId('automation-save-button')).toBeEnabled()
    if (calendar) {
      expect(screen.queryByTestId('automation-list-pane')).not.toBeInTheDocument()
    } else if (mobile) {
      expect(screen.getByTestId('automation-list-pane')).toHaveClass('hidden')
    }

    fireEvent.click(screen.getByTestId('automation-save-button'))
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
    expect(screen.queryByTestId('automation-draft-error')).not.toBeInTheDocument()
    expect(updateAutomation).toHaveBeenNthCalledWith(
      2,
      savedAutomation.id,
      expect.objectContaining({ name: '保留修改', prompt: '保留任务说明' })
    )
  }
)

test('detail-only editor keeps the existing unsaved-change confirmation', async () => {
  const owner = { userId: 7, roleId: '@primary' }
  listAutomations.mockResolvedValue({
    items: [{ ...savedAutomation, taskRequest: { standInOwner: owner, standInCalendar: {} } }],
  })
  const ref = createRef<AutomationNavigationHandle>()
  const leave = vi.fn()
  render(
    <AutomationsPage
      ref={ref}
      embedded
      detailOnly
      standInOwner={owner}
      initialAutomationId={savedAutomation.id}
    />
  )
  await screen.findByTestId('automation-name-input')
  expect(screen.queryByTestId('automation-detail-close')).not.toBeInTheDocument()
  expect(screen.getByTestId('automation-save-button')).toBeDisabled()
  fireEvent.change(screen.getByTestId('automation-name-input'), {
    target: { value: '修改后的安排' },
  })
  expect(screen.getByTestId('automation-save-button')).toBeEnabled()
  act(() => ref.current!.requestLeave(leave))
  expect(leave).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('automation-keep-editing'))
  expect(screen.getByTestId('automation-name-input')).toHaveValue('修改后的安排')
  act(() => ref.current!.requestLeave(leave))
  fireEvent.click(screen.getByTestId('automation-discard'))
  expect(leave).toHaveBeenCalledOnce()
})
