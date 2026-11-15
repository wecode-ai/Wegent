import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import {
  getSubagentName,
  getSubagentPreview,
  getSubagentStatus,
} from '../../../packages/collaboration/src/conversation/blocks/subagentPresentation'
import { chatReducer } from '@/domain/chatReducer'
import {
  collectMobileSubagents,
  mobileSubagentActive,
  mobileSubagentId,
} from '@/domain/mobileSubagents'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { ChatMessage, ChatSubagentBlock, RuntimeTaskAddress } from '@/types/runtime'
import { AssistantMarkdown } from './AssistantMarkdown'
import { LiquidGlassButton } from './LiquidGlass'
import { ProcessingTimeline } from './ProcessingTimeline'

const messages: Record<string, string> = {
  'subagent.agent': '智能体',
  'subagent.no_output': '暂无输出',
  'subagent.working': '正在工作…',
  'subagent.status_interrupted': '已中断',
  'subagent.status_failed': '失败',
  'subagent.status_done': '已完成',
  'subagent.status_working': '进行中',
}
const translate = (key: string) => messages[key] ?? key

interface ConversationAgentsPillProps {
  messages: ChatMessage[]
  address: RuntimeTaskAddress | null
  api: Pick<RuntimeApi, 'getSubagentTranscript'>
}

export function ConversationAgentsPill({ messages, address, api }: ConversationAgentsPillProps) {
  const theme = useTheme()
  const agents = useMemo(() => collectMobileSubagents(messages), [messages])
  const scope = JSON.stringify(address)
  const [openedScope, setOpenedScope] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const open = openedScope === scope
  const selected = agents.find(block => mobileSubagentId(block) === selectedId)
  const active = agents.filter(mobileSubagentActive).length
  if (!address || !agents.length) return null
  return (
    <>
      <View style={styles.touchArea}>
        <LiquidGlassButton
          accessibilityLabel={`查看 ${agents.length} 个智能体，${active} 个进行中`}
          colorScheme={theme.dark ? 'dark' : 'light'}
          contentStyle={styles.pillContent}
          fallbackStyle={{
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.outlineVariant,
          }}
          hitSlop={{ top: 7, bottom: 7 }}
          style={styles.pill}
          testID="conversation-agents"
          onPress={() => {
            setSelectedId(null)
            setOpenedScope(scope)
          }}
        >
          <Ionicons name="people-outline" size={14} color={theme.colors.onSurfaceVariant} />
          <Text style={[styles.pillLabel, { color: theme.colors.onSurfaceVariant }]}>
            {agents.length} 个智能体
          </Text>
          {active ? <View style={styles.activeDot} /> : null}
        </LiquidGlassButton>
      </View>
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => setOpenedScope(null)}
      >
        <SafeAreaProvider>
          <SafeAreaView
            style={[styles.sheet, { backgroundColor: theme.colors.background }]}
            edges={
              Platform.OS === 'android'
                ? ['top', 'left', 'right', 'bottom']
                : ['left', 'right', 'bottom']
            }
          >
            <View style={styles.header}>
              <Pressable
                testID="subagent-panel-back"
                accessibilityRole="button"
                accessibilityLabel={selected ? '返回智能体列表' : '关闭智能体'}
                style={styles.action}
                onPress={() => (selected ? setSelectedId(null) : setOpenedScope(null))}
              >
                <Ionicons
                  name={selected ? 'chevron-back' : 'close'}
                  size={22}
                  color={theme.colors.onSurface}
                />
              </Pressable>
              <Text numberOfLines={1} style={styles.title}>
                {selected ? getSubagentName(selected, translate) : '智能体'}
              </Text>
              <View style={styles.action} />
            </View>
            {open && selected ? (
              <SubagentConversation
                key={`${scope}:${selectedId}`}
                block={selected}
                address={address}
                api={api}
                onSelect={setSelectedId}
              />
            ) : (
              <ScrollView testID="subagent-overview" contentContainerStyle={styles.list}>
                {[true, false].map(running => {
                  const group = agents.filter(block => mobileSubagentActive(block) === running)
                  if (!group.length) return null
                  return (
                    <View key={String(running)} style={styles.group}>
                      <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>
                        {running ? '进行中' : '已结束'} · {group.length}
                      </Text>
                      {group.map(block => (
                        <AgentRow
                          key={mobileSubagentId(block)}
                          block={block}
                          onPress={() => setSelectedId(mobileSubagentId(block))}
                        />
                      ))}
                    </View>
                  )
                })}
              </ScrollView>
            )}
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </>
  )
}

function AgentRow({ block, onPress }: { block: ChatSubagentBlock; onPress: () => void }) {
  const theme = useTheme()
  return (
    <Pressable
      testID={`subagent-open-${mobileSubagentId(block)}`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.agentRow}
    >
      <Ionicons name="people-outline" size={22} color={theme.colors.onSurfaceVariant} />
      <View style={styles.grow}>
        <Text numberOfLines={1} variant="titleSmall">
          {getSubagentName(block, translate)}
        </Text>
        <Text
          numberOfLines={2}
          variant="bodySmall"
          style={{ color: theme.colors.onSurfaceVariant }}
        >
          {getSubagentPreview(block, translate)}
        </Text>
      </View>
      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {getSubagentStatus(block, translate)}
      </Text>
      <Ionicons name="chevron-forward" size={16} color={theme.colors.onSurfaceVariant} />
    </Pressable>
  )
}

function SubagentConversation({
  block,
  address,
  api,
  onSelect,
}: {
  block: ChatSubagentBlock
  address: RuntimeTaskAddress
  api: ConversationAgentsPillProps['api']
  onSelect: (id: string) => void
}) {
  const [history, setHistory] = useState<{
    loading: boolean
    messages: ChatMessage[]
    error?: string
  }>({ loading: false, messages: [] })
  const [revision, setRevision] = useState(0)
  const running = mobileSubagentActive(block)
  const threadId = mobileSubagentId(block)
  useEffect(() => {
    if (running) return
    const controller = new AbortController()
    setHistory({ loading: true, messages: [] })
    void api.getSubagentTranscript(address, threadId, controller.signal).then(
      response => {
        if (!controller.signal.aborted)
          setHistory({
            loading: false,
            messages: chatReducer([], { type: 'replace', messages: response.messages }),
          })
      },
      error => {
        if (!controller.signal.aborted)
          setHistory({
            loading: false,
            messages: [],
            error: error instanceof Error ? error.message : String(error),
          })
      }
    )
    return () => controller.abort()
  }, [api, address.deviceId, address.taskId, address.workspacePath, threadId, running, revision])
  const live = useMemo(
    () =>
      chatReducer([], {
        type: 'replace',
        messages: [
          {
            id: block.id,
            subtaskId: block.subtaskId,
            role: 'assistant',
            content: '',
            blocks: block.children?.map(child => ({ ...child })),
            status: running ? 'streaming' : 'completed',
            createdAt: block.createdAt,
          },
        ],
      }),
    [block, running]
  )
  const loaded = history.messages.filter(
    message => message.role === 'assistant' && (message.content.trim() || message.blocks?.length)
  )
  const content = !running && loaded.length ? loaded : live
  const childText = (block.children ?? [])
    .flatMap(child => (child.type === 'text' ? [child.content.trim()] : []))
    .join('\n\n')
  const output =
    !(!running && loaded.length) && block.output?.trim() && !childText.includes(block.output.trim())
      ? block.output
      : ''
  return (
    <ScrollView testID="subagent-conversation" contentContainerStyle={styles.conversation}>
      {block.description?.trim() ? (
        <View style={styles.delegation}>
          <AssistantMarkdown>{block.description}</AssistantMarkdown>
        </View>
      ) : null}
      {block.summary?.trim() ? <AssistantMarkdown muted>{block.summary}</AssistantMarkdown> : null}
      {content.map(message => (
        <View key={message.id} style={styles.group}>
          <ProcessingTimeline message={message} />
          {message.content.trim() ? (
            <AssistantMarkdown streaming={running}>{message.content}</AssistantMarkdown>
          ) : null}
        </View>
      ))}
      {output ? <AssistantMarkdown streaming={running}>{output}</AssistantMarkdown> : null}
      {(block.children ?? []).flatMap(child =>
        child.type === 'subagent'
          ? [
              <AgentRow
                key={child.id}
                block={child}
                onPress={() => onSelect(mobileSubagentId(child))}
              />,
            ]
          : []
      )}
      {history.loading ? <ActivityIndicator testID="subagent-history-loading" /> : null}
      {history.error ? (
        <View style={styles.group}>
          <Text testID="subagent-history-error">{history.error}</Text>
          <Pressable
            testID="subagent-history-retry"
            accessibilityRole="button"
            style={styles.action}
            onPress={() => setRevision(value => value + 1)}
          >
            <Text>重试</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  touchArea: { minHeight: 44, justifyContent: 'center' },
  pill: { height: 30, borderRadius: 15, overflow: 'hidden' },
  pillContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    height: 30,
  },
  pillLabel: { fontSize: 12, lineHeight: 17 },
  activeDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#3b8c3c' },
  sheet: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 60 },
  action: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, minWidth: 0, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  list: { padding: 20, gap: 24 },
  group: { gap: 12 },
  agentRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  grow: { flex: 1, minWidth: 0 },
  conversation: { padding: 20, gap: 20 },
  delegation: { alignSelf: 'flex-end', maxWidth: '90%' },
})
