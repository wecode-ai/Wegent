import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { AutomationEmptyState, AutomationListPane } from './AutomationListPane'
import i18n from '@/i18n'
import type { Automation } from '@/types/automation'

const scheduledReview: Automation = {
  id: 'review',
  version: 1,
  source: 'local',
  name: '每周工作复盘',
  description: '',
  prompt: 'Review work',
  enabled: true,
  schedule: { type: 'cron', expression: '0 9 * * 1' },
  timezone: 'Asia/Shanghai',
  nextRunAt: '2026-11-09T01:00:00Z',
  conversationMode: 'independent',
  notificationPolicy: 'all_runs',
  createdAt: '',
  updatedAt: '',
}

function renderSchedule(automation: Automation, locale = 'zh-CN') {
  render(
    <AutomationListPane
      automations={[automation]}
      allAutomations={[automation]}
      query=""
      statusFilter="all"
      selectedAutomationId={null}
      locale={locale}
      loading={false}
      error={null}
      detailOpen={false}
      mobileDetailOpen={false}
      onQueryChange={vi.fn()}
      onFilterChange={vi.fn()}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onClearError={vi.fn()}
      calendar
    />
  )
  return within(screen.getByTestId('automation-row-review'))
}

it.each([
  ['zh-CN', '每周一 09:00', '已开启'],
  ['en', 'Every Monday at 09:00', 'Active'],
])(
  'shows weekly timing, explicit state and the next date in %s',
  async (locale, schedule, status) => {
    const previousLanguage = i18n.language
    await i18n.changeLanguage(locale)
    try {
      const row = renderSchedule(scheduledReview, locale)
      expect(row.getByText(schedule)).toBeVisible()
      expect(row.getByText(status)).toBeVisible()
      expect(screen.getByTestId('automation-row-review')).toHaveTextContent(/Nov 9|11月9日/)
      expect(screen.getByTestId('automation-row-review')).not.toHaveTextContent('0 9 * * 1')
      expect(screen.getByTestId('automation-row-review')).not.toHaveTextContent('4d')
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  }
)

it('does not show a stale next run for paused work', () => {
  const row = renderSchedule({ ...scheduledReview, enabled: false })
  expect(row.getByText('已暂停')).toBeVisible()
  expect(row.queryByText(/下次运行/)).not.toBeInTheDocument()
})

it('does not mislabel a monthly cron schedule as daily', () => {
  const row = renderSchedule({
    ...scheduledReview,
    schedule: { type: 'cron', expression: '0 9 1 * *' },
  })
  expect(row.getByText('自定义时间安排')).toHaveAttribute('title', '0 9 1 * *')
  expect(row.queryByText(/每天/)).not.toBeInTheDocument()
})

it.each([
  ['zh-CN', '创建', '没有匹配的自动化'],
  ['en', 'Create', 'No matching automations'],
])('translates scheduled list actions and empty results in %s', async (language, create, empty) => {
  const previousLanguage = i18n.language
  await i18n.changeLanguage(language)
  try {
    render(
      <AutomationListPane
        automations={[]}
        allAutomations={[]}
        query=""
        statusFilter="all"
        selectedAutomationId={null}
        locale={language}
        loading={false}
        error={null}
        detailOpen
        mobileDetailOpen={false}
        onQueryChange={vi.fn()}
        onFilterChange={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onClearError={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: create })).toBeVisible()
    expect(screen.getByText(empty)).toBeVisible()
  } finally {
    await i18n.changeLanguage(previousLanguage)
  }
})

it('offers arranging work inside a calendar without suggesting unconnected mail access', async () => {
  const onCreate = vi.fn()
  render(
    <AutomationEmptyState
      calendar
      loading={false}
      error={null}
      query=""
      onQueryChange={vi.fn()}
      onCreate={onCreate}
      onClearError={vi.fn()}
    />
  )
  expect(screen.getByText('暂无事项，添加事项并设置触发时间。')).toBeVisible()
  expect(screen.queryByText('已安排的任务')).not.toBeInTheDocument()
  expect(screen.queryByText('每日简报')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: '添加事项' }))
  expect(onCreate).toHaveBeenCalledOnce()
})

it('keeps a calendar load failure actionable instead of presenting an empty success state', async () => {
  const retry = vi.fn()
  render(
    <AutomationEmptyState
      calendar
      loading={false}
      error="读取日历失败，请重试"
      query=""
      onQueryChange={vi.fn()}
      onCreate={vi.fn()}
      onClearError={retry}
    />
  )
  await userEvent.setup().click(screen.getByTestId('automation-error'))
  expect(retry).toHaveBeenCalledOnce()
  expect(screen.queryByText('暂无事项，添加事项并设置触发时间。')).not.toBeInTheDocument()
})
