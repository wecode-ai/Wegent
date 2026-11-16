import type { LegendListRef } from '@legendapp/list/react-native'
import React, { type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConversationFollowingContext,
  useAutomaticCollapse,
  useConversationFollowing,
} from './useConversationReading'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('native conversation reading ownership', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = undefined
  })

  it('subscribes after list readiness, follows native state and releases old dataset listeners', async () => {
    const listeners = new Set<() => void>()
    const state = {
      isFollowingEnd: true,
      listen: (name: string, listener: () => void) => {
        expect(name).toBe('isFollowingEnd')
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const ref: RefObject<LegendListRef | null> = { current: null }
    let reading!: ReturnType<typeof useConversationFollowing>
    function Probe({ dataKey }: { dataKey: string }) {
      reading = useConversationFollowing(ref, dataKey)
      return null
    }
    await act(() => {
      renderer = create(<Probe dataKey="first" />)
    })
    expect(reading.following).toBe(true)
    expect(listeners.size).toBe(0)
    ref.current = { getState: () => state } as unknown as LegendListRef
    await act(() => reading.onReady())
    expect(listeners.size).toBe(1)
    await act(() => {
      state.isFollowingEnd = false
      listeners.forEach(listener => listener())
    })
    expect(reading.following).toBe(false)
    const previous = [...listeners][0]
    await act(() => {
      renderer!.update(<Probe dataKey="second" />)
    })
    expect(listeners.size).toBe(1)
    expect([...listeners][0]).not.toBe(previous)
    await act(() => renderer!.unmount())
    renderer = undefined
    expect(listeners.size).toBe(0)
  })

  it('never delays reopening active content and folds loaded history without replaying old state', async () => {
    let collapsed = false
    function Probe({ eligible }: { eligible: boolean }) {
      collapsed = useAutomaticCollapse(eligible)
      return null
    }
    const element = (eligible: boolean) => (
      <ConversationFollowingContext.Provider value={false}>
        <Probe eligible={eligible} />
      </ConversationFollowingContext.Provider>
    )
    await act(() => {
      renderer = create(element(true))
    })
    expect(collapsed).toBe(true)
    await act(() => renderer!.update(element(false)))
    expect(collapsed).toBe(false)
    await act(() => renderer!.update(element(true)))
    expect(collapsed).toBe(false)
  })
})
