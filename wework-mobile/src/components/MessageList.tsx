import Ionicons from '@expo/vector-icons/Ionicons'
import { KeyboardAwareLegendList, useKeyboardScrollToEnd } from '@legendapp/list/keyboard'
import type { LegendListRef } from '@legendapp/list/react-native'
import * as Clipboard from 'expo-clipboard'
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'
import { type GestureResponderEvent, Pressable, StyleSheet, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'
import type { SharedValue } from 'react-native-reanimated'

import { hasAppendedUserMessage } from '@/domain/messageListScroll'
import { buildThinkingPreview } from '@/domain/messagePresentation'
import { pendingMobileUserInput } from '@/domain/requestUserInput'
import type { ChatFileChangesSummary, ChatMessage } from '@/types/runtime'
import { AssistantMarkdown } from './AssistantMarkdown'
import { MessageContextMenu, type MessageMenuAnchor } from './MessageContextMenu'
import { ProcessingTimeline } from './ProcessingTimeline'
import type { RequestUserInputHandlers } from './RequestUserInputCard'
import { useMessageListDiagnostics } from './useMessageListDiagnostics'

interface MessageListProps extends RequestUserInputHandlers {
  dataKey: string
  configuration?: ReactElement
  contentInsetEndAdjustment: SharedValue<number>
  keyboardOffset: number
  listRef: RefObject<LegendListRef | null>
  hasMoreBefore: boolean
  messages: ChatMessage[]
  loading: boolean
  loadingMoreBefore: boolean
  running: boolean
  onLoadMoreBefore: () => Promise<void>
  topInset: number
}

interface MessageMenuSelection {
  anchor: MessageMenuAnchor
  content: string
}

interface ConfigurationListItem {
  kind: 'configuration'
  id: string
}

const configurationItems: ConfigurationListItem[] = [
  { kind: 'configuration', id: 'new-conversation-configuration' },
]

export function MessageList({
  dataKey,
  configuration,
  contentInsetEndAdjustment,
  keyboardOffset,
  listRef,
  hasMoreBefore,
  messages,
  loading,
  loadingMoreBefore,
  running,
  onLoadMoreBefore,
  onRequestUserInputSubmit,
  onRequestUserInputSkip,
  topInset,
}: MessageListProps) {
  const pendingInputKeys = new Set(pendingMobileUserInput(messages).keys())
  const previousRef = useRef({ dataKey, messages, loading })
  const paginationRef = useRef({ dataKey, loading: false, userScrolled: false })
  if (paginationRef.current.dataKey !== dataKey) {
    paginationRef.current = { dataKey, loading: false, userScrolled: false }
  }
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef })
  const diagnostics = useMessageListDiagnostics({
    listRef,
    contentInsetEndAdjustment,
    dataKey,
    messages,
    running,
    freeze,
  })
  const [menuSelection, setMenuSelection] = useState<MessageMenuSelection | null>(null)

  useEffect(() => setMenuSelection(null), [dataKey])

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { dataKey, messages, loading }
    if (
      previous.dataKey !== dataKey ||
      loading ||
      previous.loading ||
      !hasAppendedUserMessage(previous.messages, messages)
    )
      return
    // The list owns measurement, animation and gesture interruption. Only a new
    // user turn overrides reading history; streamed deltas use built-in following.
    diagnostics.reportSend()
    void scrollMessageToEnd({ animated: true, closeKeyboard: false })
  }, [dataKey, diagnostics.reportSend, loading, messages, scrollMessageToEnd])

  const loadEarlier = useCallback(async () => {
    const pagination = paginationRef.current
    if (
      pagination.dataKey !== dataKey ||
      !pagination.userScrolled ||
      loading ||
      !hasMoreBefore ||
      loadingMoreBefore ||
      pagination.loading
    )
      return
    pagination.loading = true
    try {
      await onLoadMoreBefore()
    } finally {
      pagination.loading = false
    }
  }, [dataKey, loading, hasMoreBefore, loadingMoreBefore, onLoadMoreBefore])

  const handleUserScroll = useCallback(() => {
    diagnostics.reportUserScroll()
    paginationRef.current.userScrolled = true
    if (listRef.current?.getState().isAtStart) void loadEarlier()
  }, [diagnostics.reportUserScroll, listRef, loadEarlier])

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

  return (
    <>
      <KeyboardAwareLegendList<ChatMessage | ConfigurationListItem>
        alignItemsAtEnd={Boolean(configuration)}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        contentContainerStyle={[
          configuration
            ? styles.configurationContent
            : messages.length
              ? styles.content
              : styles.emptyContent,
          { paddingTop: topInset },
        ]}
        data={configuration ? configurationItems : messages}
        dataKey={dataKey}
        extraData={{
          configuration,
          loading,
          pendingInputKeys,
          onRequestUserInputSubmit,
          onRequestUserInputSkip,
        }}
        freeze={freeze}
        initialScrollAtEnd
        ItemSeparatorComponent={MessageSeparator}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        keyboardLiftBehavior="whenAtEnd"
        keyboardOffset={keyboardOffset}
        keyExtractor={message => message.id}
        ListHeaderComponent={
          loadingMoreBefore ? (
            <View style={styles.olderMessagesLoader} testID="older-messages-loader">
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        ListFooterComponent={
          <View>
            {running && messages.at(-1)?.role !== 'assistant' ? (
              <ThinkingIndicator preview="" />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.center} />
          ) : (
            <View style={styles.empty}>
              <Text variant="headlineSmall">从这里开始</Text>
              <Text style={styles.muted} variant="bodyLarge">
                选择云端项目，或直接向在线 executor 发起会话。
              </Text>
            </View>
          )
        }
        onStartReached={loadEarlier}
        onReady={diagnostics.onReady}
        onScroll={diagnostics.onScroll}
        onItemSizeChanged={diagnostics.onItemSizeChanged}
        onLayout={diagnostics.onLayout}
        onContentSizeChange={diagnostics.onContentSizeChange}
        onStartReachedThreshold={0.1}
        onUserScroll={handleUserScroll}
        maintainScrollAtEnd={{ animated: false }}
        maintainVisibleContentPosition
        ref={listRef}
        renderItem={({ item }) =>
          'kind' in item ? (
            loading ? (
              <ActivityIndicator style={styles.center} />
            ) : (
              configuration
            )
          ) : (
            <Message
              message={item}
              onLongPress={openMessageMenu}
              pendingInputKeys={pendingInputKeys}
              onRequestUserInputSubmit={onRequestUserInputSubmit}
              onRequestUserInputSkip={onRequestUserInputSkip}
            />
          )
        }
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={styles.list}
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

const Message = memo(
  function Message({
    message,
    onLongPress,
    pendingInputKeys,
    onRequestUserInputSubmit,
    onRequestUserInputSkip,
  }: {
    message: ChatMessage
    onLongPress: (message: ChatMessage, event: GestureResponderEvent) => void
    pendingInputKeys: ReadonlySet<string>
  } & RequestUserInputHandlers) {
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
        accessible={false}
        accessibilityHint={message.content.trim() ? '长按可复制消息' : undefined}
        delayLongPress={350}
        onLongPress={message.content.trim() ? event => onLongPress(message, event) : undefined}
        style={({ pressed }) => [styles.assistant, pressed && styles.messagePressed]}
        testID={`message-${message.id}`}
      >
        <ProcessingTimeline
          message={message}
          pendingInputKeys={pendingInputKeys}
          onRequestUserInputSubmit={onRequestUserInputSubmit}
          onRequestUserInputSkip={onRequestUserInputSkip}
        />
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
          <ThinkingIndicator preview="" />
        ) : null}
        {message.error ? (
          <Text style={[styles.error, { color: theme.colors.error }]} variant="bodyMedium">
            {message.error}
          </Text>
        ) : null}
      </Pressable>
    )
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.onLongPress === next.onLongPress &&
    previous.onRequestUserInputSubmit === next.onRequestUserInputSubmit &&
    previous.onRequestUserInputSkip === next.onRequestUserInputSkip &&
    previous.pendingInputKeys.size === next.pendingInputKeys.size &&
    [...previous.pendingInputKeys].every(key => next.pendingInputKeys.has(key))
)

function ThinkingIndicator({ preview }: { preview: string }) {
  const theme = useTheme()
  return (
    <Text
      numberOfLines={1}
      style={[styles.thinkingIndicator, { color: theme.colors.onSurfaceVariant }]}
      testID="thinking-indicator"
      variant="bodyMedium"
    >
      {preview ? `思考中 · ${preview}` : '思考中'}
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
  list: { flex: 1 },
  content: {
    paddingHorizontal: 18,
    paddingBottom: 20,
  },
  configurationContent: { paddingBottom: 20 },
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
  error: { marginTop: 8 },
})
