import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FlatList,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  View,
} from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'

import {
  isNearMessageListBottom,
  messageListBottomOffset,
  reduceMessageListFollow,
  shouldLoadEarlierMessages,
} from '@/domain/messageListScroll'
import { buildThinkingPreview } from '@/domain/messagePresentation'
import type { ChatFileChangesSummary, ChatMessage } from '@/types/runtime'
import { AssistantMarkdown } from './AssistantMarkdown'
import { MessageContextMenu, type MessageMenuAnchor } from './MessageContextMenu'
import { ProcessingTimeline } from './ProcessingTimeline'

interface MessageListProps {
  bottomInset: number
  conversationId: string
  entryRevision: number
  hasMoreBefore: boolean
  messages: ChatMessage[]
  loading: boolean
  loadingMoreBefore: boolean
  onLoadMoreBefore: () => Promise<void>
  topInset: number
}

interface MessageMenuSelection {
  anchor: MessageMenuAnchor
  content: string
}

export function MessageList({
  bottomInset,
  conversationId,
  entryRevision,
  hasMoreBefore,
  messages,
  loading,
  loadingMoreBefore,
  onLoadMoreBefore,
  topInset,
}: MessageListProps) {
  const listRef = useRef<FlatList<ChatMessage>>(null)
  const followsLatestRef = useRef(true)
  const userDraggingRef = useRef(false)
  const contentHeightRef = useRef(0)
  const viewportHeightRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const [menuSelection, setMenuSelection] = useState<MessageMenuSelection | null>(null)
  const scrollToLatest = useCallback(() => {
    if (!followsLatestRef.current || userDraggingRef.current) return
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      if (!followsLatestRef.current || userDraggingRef.current || viewportHeightRef.current <= 0) {
        return
      }
      listRef.current?.scrollToOffset({
        animated: false,
        offset: messageListBottomOffset(contentHeightRef.current, viewportHeightRef.current),
      })
    })
  }, [])

  useEffect(() => {
    followsLatestRef.current = reduceMessageListFollow(followsLatestRef.current, {
      type: 'conversation-entered',
    })
    userDraggingRef.current = false
    setMenuSelection(null)
    scrollToLatest()
  }, [conversationId, entryRevision, scrollToLatest])

  useEffect(() => {
    if (!messages.length || !followsLatestRef.current) return
    scrollToLatest()
  }, [messages, scrollToLatest])

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    },
    []
  )

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height
      scrollToLatest()
    },
    [scrollToLatest]
  )

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height
      scrollToLatest()
    },
    [scrollToLatest]
  )

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!userDraggingRef.current) return
      followsLatestRef.current = reduceMessageListFollow(followsLatestRef.current, {
        type: 'scroll-position-changed',
        metrics: event.nativeEvent,
        userInitiated: true,
      })
      if (
        shouldLoadEarlierMessages(
          event.nativeEvent,
          hasMoreBefore,
          loadingMoreBefore,
          userDraggingRef.current
        )
      ) {
        void onLoadMoreBefore()
      }
    },
    [hasMoreBefore, loadingMoreBefore, onLoadMoreBefore]
  )

  const handleScrollBeginDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    userDraggingRef.current = true
    followsLatestRef.current = isNearMessageListBottom(event.nativeEvent)
  }, [])

  const handleScrollEndDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    followsLatestRef.current = isNearMessageListBottom(event.nativeEvent)
    userDraggingRef.current = false
  }, [])

  const handleMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    followsLatestRef.current = isNearMessageListBottom(event.nativeEvent)
  }, [])

  const openMessageMenu = useCallback((message: ChatMessage, event: GestureResponderEvent) => {
    if (!message.content.trim()) return
    setMenuSelection({
      anchor: { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY },
      content: message.content,
    })
  }, [])

  const copySelectedMessage = useCallback(() => {
    if (!menuSelection) return
    const content = menuSelection.content
    setMenuSelection(null)
    void Clipboard.setStringAsync(content)
  }, [menuSelection])

  if (loading && messages.length === 0) return <ActivityIndicator style={styles.center} />

  return (
    <>
      <FlatList
        contentContainerStyle={[
          messages.length ? styles.content : styles.emptyContent,
          { paddingTop: topInset },
        ]}
        data={messages}
        ItemSeparatorComponent={MessageSeparator}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyExtractor={message => message.id}
        ListHeaderComponent={
          loadingMoreBefore ? (
            <View style={styles.olderMessagesLoader} testID="older-messages-loader">
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        ListFooterComponent={messages.length > 0 ? <View style={{ height: bottomInset }} /> : null}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="headlineSmall">从这里开始</Text>
            <Text style={styles.muted} variant="bodyLarge">
              选择云端项目，或直接向在线 executor 发起会话。
            </Text>
          </View>
        }
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ref={listRef}
        renderItem={({ item }) => <Message message={item} onLongPress={openMessageMenu} />}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        testID="message-list"
      />
      <MessageContextMenu
        anchor={menuSelection?.anchor ?? null}
        onCopy={copySelectedMessage}
        onDismiss={() => setMenuSelection(null)}
      />
    </>
  )
}

function MessageSeparator() {
  return <View style={styles.messageSeparator} />
}

function Message({
  message,
  onLongPress,
}: {
  message: ChatMessage
  onLongPress: (message: ChatMessage, event: GestureResponderEvent) => void
}) {
  const theme = useTheme()

  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <Pressable
          accessibilityHint="长按可复制消息"
          delayLongPress={350}
          onLongPress={event => onLongPress(message, event)}
          style={({ pressed }) => [
            styles.userBubble,
            { backgroundColor: theme.colors.surfaceVariant },
            pressed && styles.messagePressed,
          ]}
          testID={`message-${message.id}`}
        >
          <Text variant="bodyLarge">{message.content}</Text>
        </Pressable>
      </View>
    )
  }

  const thinkingPreview =
    message.status === 'streaming'
      ? buildThinkingPreview(message.streamingThinkingContent ?? '')
      : ''

  return (
    <Pressable
      accessibilityHint={message.content.trim() ? '长按可复制消息' : undefined}
      delayLongPress={350}
      onLongPress={message.content.trim() ? event => onLongPress(message, event) : undefined}
      style={({ pressed }) => [styles.assistant, pressed && styles.messagePressed]}
      testID={`message-${message.id}`}
    >
      <ProcessingTimeline message={message} />
      {message.content ? (
        <AssistantMarkdown streaming={message.status === 'streaming'}>
          {message.content}
        </AssistantMarkdown>
      ) : null}
      {message.status === 'completed' && message.fileChanges ? (
        <FileChangesSummary summary={message.fileChanges} />
      ) : null}
      {thinkingPreview ? <ThinkingIndicator preview={thinkingPreview} /> : null}
      {(message.status === 'pending' || message.status === 'streaming') &&
      !message.content &&
      !thinkingPreview &&
      !message.blocks?.length ? (
        <ActivityIndicator size={16} style={styles.streaming} />
      ) : null}
      {message.error ? (
        <Text style={[styles.error, { color: theme.colors.error }]} variant="bodyMedium">
          {message.error}
        </Text>
      ) : null}
    </Pressable>
  )
}

function ThinkingIndicator({ preview }: { preview: string }) {
  const theme = useTheme()
  return (
    <Text
      numberOfLines={1}
      style={[styles.thinkingIndicator, { color: theme.colors.onSurfaceVariant }]}
      testID="thinking-indicator"
      variant="bodyMedium"
    >
      思考中 · {preview}
    </Text>
  )
}

function FileChangesSummary({ summary }: { summary: ChatFileChangesSummary }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  return (
    <View style={styles.fileChangesContainer}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(current => !current)}
        style={[styles.fileChangesPill, { backgroundColor: theme.colors.surfaceVariant }]}
        testID="file-changes-toggle"
      >
        <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodyMedium">
          {summary.fileCount} 个文件
        </Text>
        <Text style={styles.additions} variant="bodyMedium">
          +{compactCount(summary.additions)}
        </Text>
        <Text style={styles.deletions} variant="bodyMedium">
          −{compactCount(summary.deletions)}
        </Text>
        {summary.files.length ? (
          <Ionicons
            color={theme.colors.onSurfaceVariant}
            name={expanded ? 'chevron-down' : 'chevron-forward'}
            size={16}
          />
        ) : null}
      </Pressable>
      {expanded && summary.files.length ? (
        <View
          style={[styles.fileChangesList, { backgroundColor: theme.colors.surfaceVariant }]}
          testID="file-changes-list"
        >
          {summary.files.map(file => (
            <View style={styles.fileChangeRow} key={`${file.oldPath ?? ''}:${file.path}`}>
              <Text
                numberOfLines={1}
                style={[styles.filePath, { color: theme.colors.onSurface }]}
                variant="bodyMedium"
              >
                {file.changeType === 'renamed' && file.oldPath
                  ? `${file.oldPath} → ${file.path}`
                  : file.path}
              </Text>
              {!file.binary ? (
                <View style={styles.fileStats}>
                  <Text style={styles.additions} variant="bodySmall">
                    +{file.additions}
                  </Text>
                  <Text style={styles.deletions} variant="bodySmall">
                    −{file.deletions}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function compactCount(value: number): string {
  if (Math.abs(value) < 10_000) return String(value)
  return `${Number((value / 10_000).toFixed(1))}万`
}

const styles = StyleSheet.create({
  center: { flex: 1 },
  content: {
    paddingHorizontal: 18,
  },
  messageSeparator: { height: 22 },
  olderMessagesLoader: { minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  emptyContent: { flexGrow: 1 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 8,
  },
  muted: { opacity: 0.52, textAlign: 'center' },
  userRow: { alignItems: 'flex-end' },
  userBubble: {
    maxWidth: '76%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
  },
  assistant: { width: '100%' },
  messagePressed: { opacity: 0.82 },
  thinkingIndicator: { opacity: 0.62, marginBottom: 10 },
  fileChangesContainer: { alignItems: 'center', marginTop: 10, marginBottom: 12 },
  fileChangesPill: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
  },
  fileChangesList: {
    width: '100%',
    borderRadius: 14,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  fileChangeRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 10 },
  filePath: { flex: 1 },
  fileStats: { flexDirection: 'row', gap: 8 },
  additions: { color: '#34a853' },
  deletions: { color: '#ea4335' },
  streaming: { alignSelf: 'flex-start', marginTop: 8 },
  error: { marginTop: 8 },
})
