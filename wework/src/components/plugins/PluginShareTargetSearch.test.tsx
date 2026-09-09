import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginShareTargetSearch } from './PluginShareTargetSearch'

describe('PluginShareTargetSearch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('debounces rapid input and keeps results outside the dialog layout flow', async () => {
    vi.useFakeTimers()
    const searchUsers = vi.fn(async () => [
      { id: 7, user_name: 'Admin', email: 'admin@example.com' },
    ])
    const searchGroups = vi.fn(async () => [])

    render(
      <PluginShareTargetSearch
        searchUsers={searchUsers}
        searchGroups={searchGroups}
        onSelect={vi.fn()}
      />
    )

    const input = screen.getByTestId('plugin-share-search')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ad' } })
    fireEvent.change(input, { target: { value: 'admin' } })

    expect(screen.getByTestId('plugin-share-search-results')).toHaveClass('absolute')
    expect(searchUsers).not.toHaveBeenCalled()
    expect(searchGroups).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(179)
      await Promise.resolve()
    })
    expect(searchUsers).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(searchUsers).toHaveBeenCalledTimes(1)
    expect(searchUsers).toHaveBeenCalledWith('admin')
    expect(searchGroups).toHaveBeenCalledTimes(1)
    expect(searchGroups).toHaveBeenCalledWith('admin')
    expect(screen.getByTestId('plugin-share-user-7')).toHaveTextContent('Admin')
  })

  test('ignores a stale response and clears results with the query', async () => {
    vi.useFakeTimers()
    const userResolvers = new Map<
      string,
      (users: Array<{ id: number; user_name: string; email: string }>) => void
    >()
    const searchUsers = vi.fn(
      (query: string) =>
        new Promise<Array<{ id: number; user_name: string; email: string }>>(resolve => {
          userResolvers.set(query, resolve)
        })
    )

    render(
      <PluginShareTargetSearch
        searchUsers={searchUsers}
        searchGroups={vi.fn(async () => [])}
        onSelect={vi.fn()}
      />
    )

    const input = screen.getByTestId('plugin-share-search')
    fireEvent.change(input, { target: { value: 'old' } })
    await act(async () => {
      vi.advanceTimersByTime(180)
      await Promise.resolve()
    })
    fireEvent.change(input, { target: { value: 'new' } })
    await act(async () => {
      vi.advanceTimersByTime(180)
      await Promise.resolve()
    })

    await act(async () => {
      userResolvers.get('new')?.([{ id: 2, user_name: 'New', email: 'new@example.com' }])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('plugin-share-user-2')).toHaveTextContent('New')

    await act(async () => {
      userResolvers.get('old')?.([{ id: 1, user_name: 'Old', email: 'old@example.com' }])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByTestId('plugin-share-user-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-share-user-2')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByTestId('plugin-share-search-results')).not.toBeInTheDocument()
  })

  test('finishes cleanly when search fails', async () => {
    vi.useFakeTimers()
    render(
      <PluginShareTargetSearch
        searchUsers={vi.fn(async () => {
          throw new Error('offline')
        })}
        searchGroups={vi.fn(async () => [])}
        onSelect={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('plugin-share-search'), {
      target: { value: 'admin' },
    })
    await act(async () => {
      vi.advanceTimersByTime(180)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-share-search-results')).toBeEmptyDOMElement()
  })
})
