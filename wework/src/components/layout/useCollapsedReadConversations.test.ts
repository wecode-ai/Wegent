import { act, renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { useCollapsedReadConversations } from './useCollapsedReadConversations'

describe('useCollapsedReadConversations', () => {
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
})
