import type { CloudLoopItem } from '@/api/deliveries'
import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(screen.getByTestId('cloud-todo-card-WEG-85')).not.toHaveAttribute('aria-haspopup')
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-card-drop-WEG-85')).toHaveClass('cursor-default')
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
    const trigger = screen.getByTestId('cloud-todo-card-WEG-85')
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
})

it('passes milestone metadata through the desktop card and hides it with unavailable details', () => {
  const props = {
    item,
    display: minimalDisplay,
    onClick: vi.fn(),
    onArchive: vi.fn(),
    metadata: <span data-testid="test-card-milestone">Release target</span>,
  }
  const view = render(<CloudTodoBoardCard {...props} />)
  expect(screen.getByTestId('test-card-milestone')).toHaveTextContent('Release target')
  view.rerender(<CloudTodoBoardCard {...props} item={{ ...item, can_view_detail: false }} />)
  expect(screen.queryByTestId('test-card-milestone')).not.toBeInTheDocument()
})
