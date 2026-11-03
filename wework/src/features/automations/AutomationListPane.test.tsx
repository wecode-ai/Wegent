import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { AutomationEmptyState } from './AutomationListPane'

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
  expect(screen.getByText('还没有安排。可以创建一次或周期性的工作。')).toBeVisible()
  expect(screen.queryByText('已安排的任务')).not.toBeInTheDocument()
  expect(screen.queryByText('每日简报')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: '安排工作' }))
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
  expect(screen.queryByText('还没有安排。可以创建一次或周期性的工作。')).not.toBeInTheDocument()
})
