import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatReducer } from '@/domain/chatReducer'
import type { ChatMessage, RuntimeTaskAddress } from '@/types/runtime'
import { ConversationAgentsPill } from './ConversationAgentsPill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  Platform: { OS: 'android' },
  StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ dark: false, colors: {} }),
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: 'SafeAreaProvider',
  SafeAreaView: 'SafeAreaView',
}))
vi.mock('./LiquidGlass', () => ({ LiquidGlassButton: 'GlassButton' }))
vi.mock('./AssistantMarkdown', () => ({ AssistantMarkdown: 'Markdown' }))
vi.mock('./ProcessingTimeline', () => ({ ProcessingTimeline: 'Timeline' }))

const agent = (id: string, status = 'streaming') => ({
  id: `block-${id}`,
  type: 'subagent',
  agentThreadId: id,
  status,
  createdAt: 1,
  agentType: 'Explorer',
  description: `Inspect ${id}`,
  children: [
    {
      id: `text-${id}`,
      type: 'text',
      content: 'Live child output',
      status: 'streaming',
      createdAt: 2,
    },
  ],
})
const messages = (...blocks: Record<string, unknown>[]) =>
  chatReducer([], {
    type: 'replace',
    messages: [
      { id: 'parent-message', subtaskId: 'parent-turn', role: 'assistant', content: '', blocks },
    ],
  })
const response = {
  taskId: 'parent',
  runtime: 'codex',
  workspacePath: '/repo',
  threadId: 'child',
  messages: [
    { id: 'history', role: 'assistant', content: 'Complete child history', status: 'completed' },
  ],
}

describe('conversation subagent entry and isolated child view', () => {
  let renderer: ReactTestRenderer
  let address: RuntimeTaskAddress | null
  let currentMessages: ChatMessage[]
  const api = { getSubagentTranscript: vi.fn() }
  const tree = () => (
    <ConversationAgentsPill messages={currentMessages} address={address} api={api} />
  )
  const find = (testID: string) => renderer.root.findByProps({ testID })
  const press = async (testID: string) => {
    await act(() => find(testID).props.onPress())
  }
  const render = async () => {
    await act(() => {
      renderer = create(tree())
    })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    api.getSubagentTranscript.mockResolvedValue(response)
    address = {
      deviceId: 'cloud',
      taskId: 'parent',
      threadId: 'parent-thread',
      runtime: 'codex',
      workspacePath: '/repo',
      runtimeHandle: { threadId: 'parent-thread' },
    }
    currentMessages = messages(agent('child'))
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })

  it('hides the entry until real child activity and an owning conversation are present', async () => {
    currentMessages = []
    await render()
    expect(renderer.root.findAllByType('GlassButton' as never)).toHaveLength(0)
    currentMessages = messages(agent('child'))
    address = null
    await act(() => renderer.update(tree()))
    expect(renderer.root.findAllByType('GlassButton' as never)).toHaveLength(0)
    expect(api.getSubagentTranscript).not.toHaveBeenCalled()
  })

  it('lists real active/completed agents and protects the full-screen Android sheet top edge', async () => {
    currentMessages = messages(agent('active'), agent('done', 'done'))
    await render()
    expect(find('conversation-agents').props.accessibilityLabel).toBe('查看 2 个智能体，1 个进行中')
    await press('conversation-agents')
    expect(renderer.root.findByType('Modal' as never).props.visible).toBe(true)
    expect(renderer.root.findByType('SafeAreaView' as never).props.edges).toContain('top')
    expect(find('subagent-open-active')).toBeTruthy()
    expect(find('subagent-open-done')).toBeTruthy()
    expect(api.getSubagentTranscript).not.toHaveBeenCalled()
  })

  it('shows live child output while running and reads canonical history once it completes', async () => {
    await render()
    await press('conversation-agents')
    await press('subagent-open-child')
    expect(api.getSubagentTranscript).not.toHaveBeenCalled()
    expect(renderer.root.findByType('Timeline' as never).props.message.blocks).toMatchObject([
      { content: 'Live child output' },
    ])
    currentMessages = messages(agent('child', 'done'))
    await act(() => renderer.update(tree()))
    expect(api.getSubagentTranscript).toHaveBeenCalledExactlyOnceWith(
      address,
      'child',
      expect.any(AbortSignal)
    )
    expect(renderer.root.findByType('Timeline' as never).props.message.content).toBe(
      'Complete child history'
    )
    expect(address?.threadId).toBe('parent-thread')
  })

  it('keeps failed history visible and supports an explicit retry without modifying parent routing', async () => {
    currentMessages = messages(agent('child', 'done'))
    api.getSubagentTranscript.mockRejectedValueOnce(new Error('Permission denied'))
    await render()
    await press('conversation-agents')
    await press('subagent-open-child')
    expect(find('subagent-history-error').props.children).toBe('Permission denied')
    await press('subagent-history-retry')
    expect(api.getSubagentTranscript).toHaveBeenCalledTimes(2)
    expect(renderer.root.findByType('Timeline' as never).props.message.content).toBe(
      'Complete child history'
    )
  })

  it('cancels on complete address changes and ignores late results from the previous parent scope', async () => {
    currentMessages = messages(agent('child', 'done'))
    let finish!: (value: unknown) => void
    api.getSubagentTranscript.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    await render()
    await press('conversation-agents')
    await press('subagent-open-child')
    const signal = api.getSubagentTranscript.mock.calls[0]![2] as AbortSignal
    address = { ...address!, runtimeHandle: { threadId: 'new-parent-thread' } }
    await act(() => renderer.update(tree()))
    expect(signal.aborted).toBe(true)
    expect(renderer.root.findByType('Modal' as never).props.visible).toBe(false)
    await act(() =>
      finish({
        ...response,
        messages: [{ id: 'stale', role: 'assistant', content: 'Stale history' }],
      })
    )
    await press('conversation-agents')
    await press('subagent-open-child')
    expect(api.getSubagentTranscript).toHaveBeenLastCalledWith(
      address,
      'child',
      expect.any(AbortSignal)
    )
    expect(renderer.root.findByType('Timeline' as never).props.message.content).toBe(
      'Complete child history'
    )
    await press('subagent-panel-back')
    expect(find('subagent-overview')).toBeTruthy()
  })
})
