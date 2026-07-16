import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { notifyWorkbenchCloudSearchResults } from '@/features/workbench/workbenchCloudDataEvents'
import { WorkbenchSearchDialog } from './WorkbenchSearchDialog'

function searchItem(title: string, snippet: string) {
  return {
    address: {
      deviceId: 'device-1',
      workspacePath: '/repo/Wegent',
      taskId: title,
    },
    runtime: 'codex',
    title,
    snippet,
    matchStart: 0,
    matchEnd: snippet.length,
    updatedAt: '2026-06-21T12:00:01Z',
    deviceName: 'MacBook',
    workspacePath: '/repo/Wegent',
  }
}

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
    expect(screen.getByTestId('workbench-search-result-0')).not.toHaveTextContent('⌘1')
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

  test('does not show loading state before debounce starts the request', async () => {
    vi.useFakeTimers()
    let resolveSearch: ((value: { items: [] }) => void) | undefined
    const onSearchRuntimeWork = vi.fn(
      () =>
        new Promise<{ items: [] }>(resolve => {
          resolveSearch = resolve
        })
    )

    render(
      <WorkbenchSearchDialog
        open
        onClose={vi.fn()}
        onSearchRuntimeWork={onSearchRuntimeWork}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('workbench-search-input'), {
      target: { value: 'pwd' },
    })

    expect(screen.queryByText(/正在搜索|Searching/)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180)
    })
    expect(screen.getByText(/正在搜索|Searching/)).toBeInTheDocument()

    await act(async () => {
      resolveSearch?.({ items: [] })
    })
  })

  test('reuses cached results when a query repeats', async () => {
    vi.useFakeTimers()
    const onSearchRuntimeWork = vi
      .fn()
      .mockResolvedValue({ items: [] })
      .mockResolvedValueOnce({ items: [searchItem('执行 pwd', 'pwd')] })
      .mockResolvedValueOnce({ items: [searchItem('执行 ls', 'ls')] })

    render(
      <WorkbenchSearchDialog
        open
        onClose={vi.fn()}
        onSearchRuntimeWork={onSearchRuntimeWork}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    const input = screen.getByTestId('workbench-search-input')
    fireEvent.change(input, { target: { value: 'pwd' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180)
    })
    expect(screen.getByText('执行 pwd')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'ls' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180)
    })
    expect(screen.getByText('执行 ls')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'pwd' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180)
    })

    expect(onSearchRuntimeWork).toHaveBeenCalledTimes(2)
    expect(screen.getByText('执行 pwd')).toBeInTheDocument()
  })

  test('shows local results before merging background cloud results', async () => {
    const user = userEvent.setup()
    const onSearchRuntimeWork = vi.fn().mockResolvedValue({
      items: [searchItem('Local result', 'local')],
    })

    render(
      <WorkbenchSearchDialog
        open
        onClose={vi.fn()}
        onSearchRuntimeWork={onSearchRuntimeWork}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    await user.type(screen.getByTestId('workbench-search-input'), 'result')
    expect(await screen.findByText('Local result')).toBeInTheDocument()

    act(() => {
      notifyWorkbenchCloudSearchResults({
        request: { query: 'result', limit: 20 },
        response: { items: [searchItem('Cloud result', 'cloud')] },
      })
    })

    expect(screen.getByText('Local result')).toBeInTheDocument()
    expect(screen.getByText('Cloud result')).toBeInTheDocument()
  })
})
