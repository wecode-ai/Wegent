import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkbenchSearchDialog } from './WorkbenchSearchDialog'

describe('WorkbenchSearchDialog', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('searches transcripts and opens a runtime task result', async () => {
    const user = userEvent.setup()
    const onSearchRuntimeWork = vi.fn().mockResolvedValue({
      items: [
        {
          address: {
            deviceId: 'device-1',
            workspacePath: '/repo/Wegent',
            taskId: 'codex-1',
          },
          runtime: 'codex',
          title: '执行 pwd',
          snippet: '请执行 pwd 并返回结果',
          matchStart: 3,
          matchEnd: 6,
          messageId: 'm1',
          messageRole: 'user',
          messageCreatedAt: '2026-06-21T12:00:00Z',
          updatedAt: '2026-06-21T12:00:01Z',
          deviceName: 'MacBook',
          workspacePath: '/repo/Wegent',
          project: { id: 1, name: 'Wegent' },
        },
      ],
    })
    const onOpenRuntimeTask = vi.fn()
    const onClose = vi.fn()

    render(
      <WorkbenchSearchDialog
        open
        onClose={onClose}
        onSearchRuntimeWork={onSearchRuntimeWork}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    await user.type(screen.getByTestId('workbench-search-input'), 'pwd')

    expect(await screen.findByText('执行 pwd')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-search-result-0')).toHaveTextContent(
      '请执行 pwd 并返回结果'
    )
    expect(onSearchRuntimeWork).toHaveBeenCalledWith({ query: 'pwd', limit: 20 })

    await user.click(screen.getByTestId('workbench-search-result-0'))

    await waitFor(() => {
      expect(onOpenRuntimeTask).toHaveBeenCalledWith({
        deviceId: 'device-1',
        workspacePath: '/repo/Wegent',
        taskId: 'codex-1',
      })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('starts searching after a short debounce', async () => {
    vi.useFakeTimers()
    const onSearchRuntimeWork = vi.fn().mockResolvedValue({ items: [] })

    render(
      <WorkbenchSearchDialog
        open
        onClose={vi.fn()}
        onSearchRuntimeWork={onSearchRuntimeWork}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('workbench-search-input'), {
      target: { value: '沙箱' },
    })

    expect(onSearchRuntimeWork).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(179)
    expect(onSearchRuntimeWork).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onSearchRuntimeWork).toHaveBeenCalledWith({ query: '沙箱', limit: 20 })
  })
})
