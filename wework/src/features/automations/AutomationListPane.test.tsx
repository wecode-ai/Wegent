import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { AutomationEmptyState, AutomationListPane } from './AutomationListPane'
import i18n from '@/i18n'

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
