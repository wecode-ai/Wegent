import { act, renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { useCollapsedReadConversations } from './useCollapsedReadConversations'

describe('useCollapsedReadConversations', () => {
  test('expands only requested conversations and preserves other groups', () => {
    const { result } = renderHook(() =>
      useCollapsedReadConversations(
        'alice',
        new Set(['local\0project-task', 'remote\0project-task', 'local\0chat']),
        new Set()
      )
    )
    act(() => result.current.collapseReadConversations())
    act(() => result.current.expandReadConversations(new Set(['local\0project-task'])))

    expect([...result.current.collapsedReadTaskKeys]).toEqual([
      'remote\0project-task',
      'local\0chat',
    ])
    act(() => result.current.expandReadConversations())
    expect(result.current.collapsedReadTaskKeys.size).toBe(0)
  })

  test('scopes task identities by device and leaves newly created conversations visible', () => {
    const props = {
      taskKeys: new Set(['local\0same-id', 'remote\0same-id']),
      unreadKeys: new Set(['remote\0same-id']),
    }
    const { result, rerender } = renderHook(
      ({ taskKeys, unreadKeys }) => useCollapsedReadConversations('alice', taskKeys, unreadKeys),
      { initialProps: props }
    )
    act(() => result.current.collapseReadConversations())
    expect([...result.current.collapsedReadTaskKeys]).toEqual(['local\0same-id'])

    rerender({ ...props, taskKeys: new Set([...props.taskKeys, 'local\0new-task']) })
    expect([...result.current.collapsedReadTaskKeys]).toEqual(['local\0same-id'])
  })

  test('prunes removed conversations so a recreated address is visible', () => {
    const { result, rerender } = renderHook(
      ({ taskKeys }) => useCollapsedReadConversations('alice', taskKeys, new Set()),
      { initialProps: { taskKeys: new Set(['local\0task']) } }
    )
    act(() => result.current.collapseReadConversations())
    rerender({ taskKeys: new Set() })
    rerender({ taskKeys: new Set(['local\0task']) })
    expect(result.current.collapsedReadTaskKeys.size).toBe(0)
  })
})
