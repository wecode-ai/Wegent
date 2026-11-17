import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { IssueExistingTaskPicker } from './IssueExistingTaskPicker'

const tasks = [
  { title: 'Fix renderer', address: { deviceId: 'local', taskId: 'one' } },
  { title: 'Review API', address: { deviceId: 'local', taskId: 'two' } },
]

describe('IssueExistingTaskPicker', () => {
  it('searches existing tasks and links the selected address without creating a task', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn().mockResolvedValue(undefined)
    render(<IssueExistingTaskPicker tasks={tasks} onSelect={onSelect} />)
    await user.click(screen.getByTestId('issue-link-existing-task'))
    await user.type(screen.getByTestId('issue-existing-task-search'), 'renderer')
    expect(screen.queryByText('Review API')).not.toBeInTheDocument()
    await user.click(screen.getByText('Fix renderer'))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(tasks[0])
    await waitFor(() =>
      expect(screen.queryByTestId('issue-existing-task-picker')).not.toBeInTheDocument()
    )
  })

  it('keeps failures visible and allows another attempt', async () => {
    const user = userEvent.setup()
    const onSelect = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    render(<IssueExistingTaskPicker tasks={tasks} onSelect={onSelect} />)
    await user.click(screen.getByTestId('issue-link-existing-task'))
    await user.click(screen.getByText('Fix renderer'))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    await user.click(screen.getByText('Fix renderer'))
    await waitFor(() =>
      expect(screen.queryByTestId('issue-existing-task-picker')).not.toBeInTheDocument()
    )
    expect(onSelect).toHaveBeenCalledTimes(2)
  })
})
