import type { LegendListRef } from '@legendapp/list/react-native'
import React from 'react'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMessageListDiagnostics } from './useMessageListDiagnostics'

const cache = vi.hoisted(() => ({ record: vi.fn() }))
vi.mock('@/services/chatLayoutDiagnostics', () => ({
  recordChatLayoutDiagnostic: cache.record,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Options = Parameters<typeof useMessageListDiagnostics>[0]

describe('opt-in message list diagnostics', () => {
  let renderer: ReactTestRenderer | null
  let options: Options
  let diagnostics: ReturnType<typeof useMessageListDiagnostics>
  let time: number
  const output = vi.fn()
  const getState = vi.fn(() => ({
    scroll: 360,
    scrollLength: 700,
    contentLength: 1296,
    distanceFromEnd: 236,
    isFollowingEnd: false,
    isAtEnd: false,
    isWithinMaintainScrollAtEndThreshold: false,
    data: [{ id: 'private-state-id', content: 'private-state-content' }],
  }))
  const scrollEvent = {
    nativeEvent: {
      contentInset: { bottom: 96 },
      contentOffset: { y: 360 },
      contentSize: { height: 1200 },
      layoutMeasurement: { height: 700 },
    },
  } as NativeSyntheticEvent<NativeScrollEvent>
  const layoutEvent = {
    nativeEvent: { layout: { width: 390, height: 700 } },
  } as LayoutChangeEvent
  const itemSize = { index: 1, previous: 120, size: 147, itemKey: 'private-item-key' }

  function Harness(props: Options) {
    diagnostics = useMessageListDiagnostics(props)
    return null
  }

  async function render(next: Partial<Options> = {}) {
    options = { ...options, ...next }
    await act(() => {
      if (renderer) renderer.update(<Harness {...options} />)
      else renderer = create(<Harness {...options} />)
    })
  }

  const logs = () =>
    output.mock.calls.map(([, value]) => JSON.parse(value as string) as Record<string, unknown>)

  beforeEach(() => {
    renderer = null
    time = 1000
    vi.stubEnv('EXPO_PUBLIC_CHAT_LAYOUT_DIAGNOSTICS', '1')
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    vi.spyOn(console, 'info').mockImplementation(output)
    output.mockClear()
    cache.record.mockClear()
    getState.mockClear()
    options = {
      listRef: { current: { getState } as unknown as LegendListRef },
      contentInsetEndAdjustment: { value: 96 } as SharedValue<number>,
      freeze: { value: false } as SharedValue<boolean>,
      dataKey: 'private-device:private-conversation',
      messages: [
        {
          id: 'private-message-id',
          role: 'assistant',
          status: 'streaming',
          content: 'private-message-content',
          createdAt: 1,
        },
      ],
      running: true,
    }
  })

  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it.each([undefined, '0'])(
    'does not attach callbacks or read state when disabled (%s)',
    async flag => {
      vi.stubEnv('EXPO_PUBLIC_CHAT_LAYOUT_DIAGNOSTICS', flag)
      const readInset = vi.fn(() => 96)
      const inset = Object.defineProperty({}, 'value', { get: readInset }) as SharedValue<number>
      await render({ contentInsetEndAdjustment: inset })

      expect(diagnostics.onReady).toBeUndefined()
      expect(diagnostics.onScroll).toBeUndefined()
      expect(diagnostics.onItemSizeChanged).toBeUndefined()
      expect(diagnostics.onLayout).toBeUndefined()
      expect(diagnostics.onContentSizeChange).toBeUndefined()
      diagnostics.reportSend()
      diagnostics.reportUserScroll()
      await render({ running: false, dataKey: 'another-private-conversation' })
      expect(output).not.toHaveBeenCalled()
      expect(cache.record).not.toHaveBeenCalled()
      expect(getState).not.toHaveBeenCalled()
      expect(readInset).not.toHaveBeenCalled()
    }
  )

  it('records only selected geometry and tail metadata without content or identifiers', async () => {
    await render()
    diagnostics.onScroll!(scrollEvent)
    diagnostics.onItemSizeChanged!(itemSize)
    diagnostics.onLayout!(layoutEvent)
    diagnostics.onContentSizeChange!(390, 1200)

    expect(output.mock.calls.every(([prefix]) => prefix === '[ChatLayout]')).toBe(true)
    expect(logs().find(log => log.event === 'scroll')).toMatchObject({
      epoch: 1,
      timestamp: 1000,
      running: true,
      messageCount: 1,
      tailRole: 'assistant',
      tailStatus: 'streaming',
      tailLength: options.messages[0]!.content.length,
      composerInset: 96,
      freeze: false,
      nativeInsetBottom: 96,
      nativeOffsetY: 360,
      nativeContentHeight: 1200,
      nativeViewportHeight: 700,
      legend: {
        scroll: 360,
        scrollLength: 700,
        contentLength: 1296,
        distanceFromEnd: 236,
        isFollowingEnd: false,
        isAtEnd: false,
        isWithinMaintainScrollAtEndThreshold: false,
      },
    })
    expect(logs().find(log => log.event === 'itemSize')).toMatchObject({
      itemIndex: 1,
      previousItemHeight: 120,
      itemHeight: 147,
    })
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
    expect(cache.record.mock.calls).toEqual(output.mock.calls.map(([, value]) => [value]))
    expect(logs().find(log => log.event === 'layout')).toMatchObject({
      layoutWidth: 390,
      layoutHeight: 700,
    })
    expect(logs().find(log => log.event === 'contentSize')).toMatchObject({
      contentWidth: 390,
      contentHeight: 1200,
    })
  })

  it('throttles each high-frequency event independently before reading list state', async () => {
    await render()
    output.mockClear()
    getState.mockClear()
    const reportAll = () => {
      diagnostics.onScroll!(scrollEvent)
      diagnostics.onItemSizeChanged!(itemSize)
      diagnostics.onLayout!(layoutEvent)
      diagnostics.onContentSizeChange!(390, 1200)
    }
    reportAll()
    time += 199
    reportAll()
    expect(output).toHaveBeenCalledTimes(4)
    expect(getState).toHaveBeenCalledTimes(4)
    time += 1
    reportAll()
    expect(output).toHaveBeenCalledTimes(8)
    expect(getState).toHaveBeenCalledTimes(8)
  })

  it('always records ready, sends, user gestures and running transitions', async () => {
    await render()
    output.mockClear()
    diagnostics.onReady!()
    diagnostics.onReady!()
    diagnostics.reportSend()
    diagnostics.reportSend()
    diagnostics.reportUserScroll()
    diagnostics.reportUserScroll()
    await render({ running: false })
    await render({ running: true })

    expect(logs().map(log => log.event)).toEqual([
      'ready',
      'ready',
      'send',
      'send',
      'user',
      'user',
      'running',
      'running',
    ])
    expect(
      logs()
        .slice(-2)
        .map(log => log.running)
    ).toEqual([false, true])
  })

  it('retains stable callbacks with current metadata and resets throttling for a new epoch', async () => {
    await render()
    const callbacks = diagnostics
    diagnostics.onScroll!(scrollEvent)
    await render({
      dataKey: 'another-private-conversation',
      messages: [],
      contentInsetEndAdjustment: { value: 140 } as SharedValue<number>,
      freeze: { value: true } as SharedValue<boolean>,
    })
    expect(diagnostics).toBe(callbacks)
    diagnostics.onScroll!(scrollEvent)
    expect(logs().at(-1)).toMatchObject({
      event: 'scroll',
      epoch: 2,
      messageCount: 0,
      tailRole: null,
      tailStatus: null,
      tailLength: 0,
      composerInset: 140,
      freeze: true,
    })
    await render({ listRef: { current: null } })
    diagnostics.reportSend()
    expect(logs().at(-1)?.legend).toBeNull()
  })
})
