import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem } from '@/api/deliveries'
import { CloudTodoBoardCard } from './CloudTodoBoardCard'

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: () => null,
}))

vi.mock('@/features/workbench/changeRequestMonitor', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/workbench/changeRequestMonitor')>()),
  useTaskChangeRequest: () => null,
}))

afterEach(() => vi.useRealTimers())

const item = {
  id: 'WEG-85',
  title: 'Keep the pull request popup visible',
  description: null,
  status: 'in_review',
  priority: 'none',
  can_edit: true,
  can_view_detail: true,
  updated_at: '2026-08-21T00:00:00Z',
} as CloudLoopItem

const progressBindings = [
  {
    id: 85,
    device_id: 'local',
    task_id: 'task-85',
    task_title: 'Fix the board popup',
    running: true,
  },
]
const minimalDisplay = {
  showAssignee: false,
  showPriority: false,
  showTags: false,
  showDate: false,
}

describe('board progress activation', () => {
  it.each(['drop', 'tasks', 'task-summary'])(
    'opens the Issue once from the %s area',
    async area => {
      const onClick = vi.fn()
      render(
        <CloudTodoBoardCard
          item={item}
          taskBindings={progressBindings}
          display={minimalDisplay}
          onClick={onClick}
          onArchive={vi.fn()}
          processingStatus={false}
        />
      )
      const suffix = area === 'task-summary' ? '-85' : ''
      await userEvent.click(screen.getByTestId(`cloud-todo-card-${area}-WEG-85${suffix}`))
      expect(onClick).toHaveBeenCalledOnce()
      expect(screen.getByTestId('cloud-todo-card-WEG-85')).toHaveFocus()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByTestId('cloud-todo-card-drop-WEG-85')).toHaveClass('cursor-default')
    }
  )

  it('disables Issue details and hides progress when detail access is unavailable', async () => {
    const onClick = vi.fn()
    render(
      <CloudTodoBoardCard
        item={{ ...item, can_view_detail: false }}
        taskBindings={progressBindings}
        display={minimalDisplay}
        onClick={onClick}
        onArchive={vi.fn()}
        processingStatus={false}
      />
    )
    await userEvent.click(screen.getByTestId('cloud-todo-card-drop-WEG-85'))
    expect(screen.getByTestId('cloud-todo-card-WEG-85')).toBeDisabled()
    await userEvent.click(screen.getByTestId('cloud-todo-card-WEG-85'))
    expect(screen.queryByTestId('cloud-todo-card-tasks-WEG-85')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-progress-trigger-WEG-85')).not.toBeInTheDocument()
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-todo-card-drop-WEG-85')).toHaveClass('cursor-default')
  })

  it('keeps progress and menu actions separate from the card primary action', async () => {
    const onClick = vi.fn()
    const onArchive = vi.fn()
    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={progressBindings}
        display={minimalDisplay}
        onClick={onClick}
        onArchive={onArchive}
        processingStatus={false}
      />
    )
    await userEvent.click(screen.getByTestId('cloud-todo-card-progress-trigger-WEG-85'))
    await userEvent.click(screen.getByTestId('cloud-todo-card-progress-popup-content-WEG-85'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-todo-card-progress-popup-WEG-85-close'))
    await userEvent.click(screen.getByTestId('cloud-todo-card-more-WEG-85'))
    await userEvent.click(screen.getByTestId('cloud-todo-card-archive-WEG-85'))
    expect(onArchive).toHaveBeenCalledOnce()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('scopes the card shortcut hover state to the current card', async () => {
    const onClick = vi.fn()
    const onConfirm = vi.fn()
    render(
      <CloudTodoBoardCard
        item={item}
        display={minimalDisplay}
        onClick={onClick}
        onArchive={vi.fn()}
        processingStatus={false}
        cardAction={{
          kind: 'confirm',
          label: '确认完成',
          testId: 'card-confirm',
          onClick: onConfirm,
        }}
      />
    )

    const card = screen.getByTestId('cloud-todo-card-drop-WEG-85')
    const shortcut = screen.getByTestId('card-confirm')
    expect(card).toHaveClass('group/cloud-todo-card')
    expect(shortcut).toHaveClass('group-hover/cloud-todo-card:opacity-100')
    expect(shortcut).not.toHaveClass('group-hover:opacity-100')

    await userEvent.click(shortcut)
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('never opens or marks read on hover, focus, or an ordinary Issue click', async () => {
    vi.useFakeTimers()
    const onClick = vi.fn()
    const onMarkRead = vi.fn()
    render(
      <CloudTodoBoardCard
        item={{ ...item, is_unread: true }}
        taskBindings={progressBindings}
        display={minimalDisplay}
        onClick={onClick}
        onArchive={vi.fn()}
        onMarkRead={onMarkRead}
        processingStatus={false}
      />
    )
    const card = screen.getByTestId('cloud-todo-card-WEG-85')
    fireEvent.mouseEnter(card)
    fireEvent.focus(card)
    await act(async () => vi.advanceTimersByTime(5000))
    fireEvent.pointerDown(card)
    fireEvent.click(card)
    await act(async () => vi.advanceTimersByTime(5000))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClick).toHaveBeenCalledOnce()
    expect(onMarkRead).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('opens with keyboard activation, stays open on pointer exit, and restores focus on Escape', async () => {
    const user = userEvent.setup()
    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={progressBindings}
        display={minimalDisplay}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        processingStatus={false}
      />
    )
    const trigger = screen.getByTestId('cloud-todo-card-progress-trigger-WEG-85')
    trigger.focus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.mouseLeave(screen.getByRole('dialog'))
    fireEvent.pointerMove(document.body)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.keyboard(' ')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByTestId('cloud-todo-card-progress-popup-WEG-85-close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('lets the first outside click open the Issue without reopening the progress panel', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={progressBindings}
        display={minimalDisplay}
        onClick={onClick}
        onArchive={vi.fn()}
        processingStatus={false}
      />
    )
    await user.click(screen.getByTestId('cloud-todo-card-progress-trigger-WEG-85'))
    await user.click(screen.getByTestId('cloud-todo-card-WEG-85'))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('hides the progress trigger when previews are disabled', () => {
    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={progressBindings}
        display={minimalDisplay}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        processingStatus={false}
        previewDisabled
      />
    )
    expect(screen.queryByTestId('cloud-todo-card-progress-trigger-WEG-85')).not.toBeInTheDocument()
  })
  it('keeps the card DOM stable and does not reopen after preview availability returns', async () => {
    const props = {
      item,
      taskBindings: progressBindings,
      display: minimalDisplay,
      onClick: vi.fn(),
      onArchive: vi.fn(),
      processingStatus: false,
    }
    const { rerender } = render(<CloudTodoBoardCard {...props} />)
    const card = screen.getByTestId('cloud-todo-card-WEG-85')
    await userEvent.click(screen.getByTestId('cloud-todo-card-progress-trigger-WEG-85'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    rerender(<CloudTodoBoardCard {...props} previewDisabled />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-WEG-85')).toBe(card)
    rerender(<CloudTodoBoardCard {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-WEG-85')).toBe(card)
    await userEvent.click(screen.getByTestId('cloud-todo-card-progress-trigger-WEG-85'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
