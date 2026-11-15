import type { LegendListRef } from '@legendapp/list/react-native'
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'

import { recordChatLayoutDiagnostic } from '@/services/chatLayoutDiagnostics'
import type { ChatMessage } from '@/types/runtime'

interface MessageListDiagnosticsOptions {
  listRef: RefObject<LegendListRef | null>
  contentInsetEndAdjustment: SharedValue<number>
  dataKey: string
  messages: readonly ChatMessage[]
  running: boolean
  freeze?: SharedValue<boolean>
}

type DiagnosticEvent =
  'ready' | 'scroll' | 'itemSize' | 'layout' | 'contentSize' | 'user' | 'send' | 'running'
type NumericDetails = () => Record<string, number>
const ignoreDiagnostic = () => {}

export function useMessageListDiagnostics(options: MessageListDiagnosticsOptions) {
  const enabled = process.env.EXPO_PUBLIC_CHAT_LAYOUT_DIAGNOSTICS === '1'
  const latest = useRef(options)
  latest.current = options
  const session = useRef({
    dataKey: options.dataKey,
    epoch: 1,
    lastReportedAt: new Map<DiagnosticEvent, number>(),
  })

  const report = useCallback(
    (event: DiagnosticEvent, details?: NumericDetails, force = false) => {
      if (!enabled) return
      const current = latest.current
      if (session.current.dataKey !== current.dataKey) {
        session.current = {
          dataKey: current.dataKey,
          epoch: session.current.epoch + 1,
          lastReportedAt: new Map(),
        }
      }
      const timestamp = Date.now()
      const previous = session.current.lastReportedAt.get(event)
      if (!force && previous !== undefined && timestamp - previous < 200) return
      session.current.lastReportedAt.set(event, timestamp)

      const state = current.listRef.current?.getState()
      const tail = current.messages.at(-1)
      const record = JSON.stringify({
        event,
        epoch: session.current.epoch,
        timestamp,
        running: current.running,
        messageCount: current.messages.length,
        tailRole: tail?.role ?? null,
        tailStatus: tail?.status ?? null,
        tailLength: tail?.content.length ?? 0,
        composerInset: current.contentInsetEndAdjustment.value,
        freeze: current.freeze?.value ?? null,
        legend: state
          ? {
              scroll: state.scroll,
              scrollLength: state.scrollLength,
              contentLength: state.contentLength,
              distanceFromEnd: state.distanceFromEnd,
              isFollowingEnd: state.isFollowingEnd,
              isAtEnd: state.isAtEnd,
              isWithinMaintainScrollAtEndThreshold: state.isWithinMaintainScrollAtEndThreshold,
            }
          : null,
        ...details?.(),
      })
      console.info('[ChatLayout]', record)
      recordChatLayoutDiagnostic(record)
    },
    [enabled]
  )

  useEffect(() => {
    report('running', undefined, true)
  }, [options.dataKey, options.running, report])

  return useMemo(() => {
    if (!enabled) {
      return {
        onReady: undefined,
        onScroll: undefined,
        onItemSizeChanged: undefined,
        onLayout: undefined,
        onContentSizeChange: undefined,
        reportUserScroll: ignoreDiagnostic,
        reportSend: ignoreDiagnostic,
      }
    }
    return {
      onReady: () => report('ready', undefined, true),
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) =>
        report('scroll', () => ({
          nativeInsetBottom: event.nativeEvent.contentInset.bottom,
          nativeOffsetY: event.nativeEvent.contentOffset.y,
          nativeContentHeight: event.nativeEvent.contentSize.height,
          nativeViewportHeight: event.nativeEvent.layoutMeasurement.height,
        })),
      onItemSizeChanged: (info: { index: number; previous: number; size: number }) =>
        report('itemSize', () => ({
          itemIndex: info.index,
          previousItemHeight: info.previous,
          itemHeight: info.size,
        })),
      onLayout: (event: LayoutChangeEvent) =>
        report('layout', () => ({
          layoutWidth: event.nativeEvent.layout.width,
          layoutHeight: event.nativeEvent.layout.height,
        })),
      onContentSizeChange: (width: number, height: number) =>
        report('contentSize', () => ({ contentWidth: width, contentHeight: height })),
      reportUserScroll: () => report('user', undefined, true),
      reportSend: () => report('send', undefined, true),
    }
  }, [enabled, report])
}
