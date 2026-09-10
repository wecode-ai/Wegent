import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BoardLayoutEditor } from './BoardLayoutEditor'

const statuses = [
  { id: 'inbox', name: '收集箱', color: 'gray' as const },
  { id: 'todo', name: '待开始', color: 'blue' as const },
]

const display = {
  showAssignee: true,
  showPriority: true,
  showTags: true,
  showDate: true,
}

describe('BoardLayoutEditor', () => {
  it('uses a compact preview and changes card fields from the display menu', async () => {
    const onDisplayChange = vi.fn()
    render(
      <BoardLayoutEditor
        statuses={statuses}
        display={display}
        statusBusy={false}
        displayBusy={false}
        canEditStatuses
        onStatusesChange={vi.fn()}
        onDisplayChange={onDisplayChange}
      />
    )

    expect(screen.getByTestId('cloud-project-board-layout-settings')).toHaveTextContent('看板布局')
    expect(screen.getByText('补充项目管理页的空状态')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-board-display-menu'))
    await userEvent.click(screen.getByTestId('cloud-board-display-assignee'))

    expect(onDisplayChange).toHaveBeenCalledWith('showAssignee', false)
  })

  it('adds a status from the end of the miniature board', async () => {
    const onStatusesChange = vi.fn()
    render(
      <BoardLayoutEditor
        statuses={statuses}
        display={display}
        statusBusy={false}
        displayBusy={false}
        canEditStatuses
        onStatusesChange={onStatusesChange}
        onDisplayChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('cloud-board-status-add'))

    expect(onStatusesChange).toHaveBeenCalledWith([
      ...statuses,
      expect.objectContaining({ name: '新状态', color: 'orange' }),
    ])
  })
})
