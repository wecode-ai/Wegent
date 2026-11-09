import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { Automation } from '@/types/automation'
import { AutomationsPage } from './AutomationsPage'
import { automationDraftFromAutomation, scheduleFromAutomationDraft } from './automationDraft'

const mocks = vi.hoisted(() => ({
  listAutomations: vi.fn(async (): Promise<{ items: Automation[] }> => ({ items: [] })),
  onboarding: vi.fn(),
}))
vi.mock('@/features/auth/useAuth', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('@/features/workbench/useWorkbench', () => {
  const context = {
    state: {
      devices: [
        { id: 1, device_id: 'local', device_type: 'local', status: 'online', name: 'Local' },
      ],
      runtimeWork: { projects: [], chats: [] },
      currentRuntimeTask: null,
    },
    services: {
      automationApi: { listAutomations: mocks.listAutomations },
      standInApi: { onboarding: mocks.onboarding },
    },
    projectChat: { models: [], selectedModel: null, selectedModelOptions: {} },
    refreshWorkLists: vi.fn(),
  }
  return { useWorkbench: () => context }
})

const entry = (id: string, roleId: string): Automation => ({
  id,
  version: 1,
  source: 'local',
  name: id,
  description: '',
  prompt: 'Event',
  schedule: { type: 'cron', expression: '0 9 * * 1-5' },
  timezone: 'UTC',
  enabled: true,
  conversationMode: 'independent',
  notificationPolicy: 'all_runs',
  taskRequest: {
    schemaVersion: 2,
    runtime: 'codex',
    deviceId: 'local',
    message: 'Event',
    standInOwner: { userId: 7, roleId },
    standInCalendar: {},
  },
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
})

it('opens the shared weekly review template as an unsaved Monday draft', async () => {
  mocks.onboarding.mockResolvedValueOnce({
    state: { completed: true },
    reviewTemplate: {
      ...entry('template', '@primary'),
      name: '每周工作复盘',
      prompt: 'Review evidence',
      schedule: { type: 'cron', expression: '0 9 * * 1' },
      taskRequest: {
        ...entry('template', '@primary').taskRequest!,
        standInCalendar: { template: 'weekly_review' },
      },
      timezone: 'Asia/Shanghai',
    },
  })
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: '@primary' }}
      standInDeviceId="local"
    />
  )
  await userEvent.click(await screen.findByTestId('stand-in-weekly-review-template'))
  expect(await screen.findByTestId('automation-name-input')).toHaveValue('每周工作复盘')
  expect(screen.getByTestId('automation-prompt-input')).toHaveValue('Review evidence')
  expect(mocks.onboarding).toHaveBeenCalledWith(7, 'local', expect.any(String))
})

it('shows an existing review once and opens it from the list', async () => {
  const review = entry('existing-review', '@primary')
  review.taskRequest!.standInCalendar = { template: 'weekly_review' }
  mocks.listAutomations.mockResolvedValueOnce({ items: [review] })
  mocks.onboarding.mockClear()
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: '@primary' }}
      standInDeviceId="local"
    />
  )
  const reviewEntry = await screen.findByTestId('automation-open-existing-review')
  expect(screen.queryByTestId('stand-in-weekly-review-template')).not.toBeInTheDocument()
  await userEvent.click(reviewEntry)
  expect(await screen.findByTestId('automation-name-input')).toHaveValue('existing-review')
  expect(mocks.onboarding).not.toHaveBeenCalled()
})

it('preserves the memory review identity and interval when opening its editable draft', async () => {
  const review = entry('memory-review', '@primary')
  review.taskRequest!.standInCalendar = { template: 'memory_review' }
  review.schedule = { type: 'interval', value: 6, unit: 'hours' }
  const draft = automationDraftFromAutomation(review)
  expect(draft.calendarTemplate).toBe('memory_review')
  expect(scheduleFromAutomationDraft(draft)).toEqual(review.schedule)
  mocks.listAutomations.mockResolvedValueOnce({ items: [review] })
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: '@primary' }}
      standInDeviceId="local"
    />
  )
  await userEvent.click(await screen.findByTestId('automation-open-memory-review'))
  expect(await screen.findByTestId('automation-name-input')).toHaveValue('memory-review')
})

it('uses a single embedded pane on desktop and protects a schedule draft before returning to the list', async () => {
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: '@primary' }}
      standInDeviceId="local"
    />
  )
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('create-automation-button'))
  expect(screen.getByTestId('automation-detail-panel')).toBeVisible()
  expect(screen.queryByTestId('automation-list-pane')).not.toBeInTheDocument()
  expect(screen.getByTestId('automation-name-input')).toBeVisible()
  expect(screen.getByTestId('automation-prompt-input')).toBeVisible()
  expect(screen.queryByTestId('automation-immediate-switch')).not.toBeInTheDocument()
  expect(screen.queryByTestId('automation-goal-switch')).not.toBeInTheDocument()
  expect(screen.queryByTestId('automation-conversation-mode')).not.toBeInTheDocument()
  await user.type(screen.getByTestId('automation-name-input'), 'Draft schedule')
  await user.click(screen.getByTestId('automation-detail-close'))
  expect(screen.getByTestId('automation-name-input')).toHaveValue('Draft schedule')
  await user.click(await screen.findByTestId('automation-keep-editing'))
  expect(screen.getByTestId('automation-name-input')).toHaveValue('Draft schedule')
  await user.click(screen.getByTestId('automation-detail-close'))
  await user.click(await screen.findByTestId('automation-discard'))
  expect(screen.queryByTestId('automation-detail-panel')).not.toBeInTheDocument()
  expect(screen.getByTestId('create-automation-button')).toBeVisible()
})

it('inherits the calendar connection processing policy without an event override', async () => {
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: 'reviewer' }}
      standInDeviceId="local"
    />
  )
  await userEvent.click(await screen.findByTestId('create-automation-button'))
  expect(screen.queryByTestId('automation-immediate-switch')).not.toBeInTheDocument()
  expect(screen.queryByTestId('automation-model-select')).not.toBeInTheDocument()
})

it('lists only the current identity’s calendar entries', async () => {
  mocks.listAutomations.mockResolvedValueOnce({
    items: [entry('primary-event', '@primary'), entry('role-event', 'reviewer')],
  })
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: '@primary' }}
      standInDeviceId="local"
    />
  )
  expect(await screen.findByTestId('automation-open-primary-event')).toBeVisible()
  expect(screen.queryByTestId('automation-open-role-event')).not.toBeInTheDocument()
})

it('keeps ordinary schedules separate from calendar events and restores their execution controls', async () => {
  const calendar = entry('calendar-event', '@primary')
  const ordinary = entry('ordinary-schedule', '@primary')
  delete ordinary.taskRequest!.standInCalendar
  mocks.listAutomations.mockResolvedValueOnce({ items: [calendar, ordinary] })
  render(<AutomationsPage embedded />)
  expect(await screen.findByTestId('automation-name-input')).toHaveValue('ordinary-schedule')
  await userEvent.click(screen.getByTestId('automation-detail-close'))
  expect(await screen.findByTestId('automation-open-ordinary-schedule')).toBeVisible()
  expect(screen.queryByTestId('automation-open-calendar-event')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('create-automation-button'))
  expect(screen.getByTestId('automation-goal-switch')).toBeVisible()
  expect(screen.getByTestId('automation-conversation-mode')).toBeVisible()
  expect(screen.getByTestId('automation-model-select')).toBeVisible()
})

it('does not adopt older schedules into a calendar connection', async () => {
  const ordinary = entry('older-schedule', '@primary')
  delete ordinary.taskRequest!.standInCalendar
  mocks.listAutomations.mockResolvedValueOnce({
    items: [entry('calendar-event', '@primary'), ordinary],
  })
  render(
    <AutomationsPage
      embedded
      standInOwner={{ userId: 7, roleId: '@primary' }}
      standInDeviceId="local"
    />
  )
  expect(await screen.findByTestId('automation-open-calendar-event')).toBeVisible()
  expect(screen.queryByTestId('automation-open-older-schedule')).not.toBeInTheDocument()
})
