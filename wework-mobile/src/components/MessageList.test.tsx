import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/types/runtime'
import { MessageList } from './MessageList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Pressable: 'Pressable',
  FlatList: ({
    data,
    renderItem,
    ListFooterComponent,
  }: {
    data: ChatMessage[]
    renderItem: (value: { item: ChatMessage }) => React.ReactNode
    ListFooterComponent: React.ReactNode
  }) => (
    <>
      {data.map(item => (
        <React.Fragment key={item.id}>{renderItem({ item })}</React.Fragment>
      ))}
      {ListFooterComponent}
    </>
  ),
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
  useTheme: () => ({ colors: { surfaceVariant: 'gray', onSurfaceVariant: 'gray' } }),
}))
vi.mock('./AssistantMarkdown', () => ({ AssistantMarkdown: 'AssistantMarkdown' }))
vi.mock('./MessageContextMenu', () => ({ MessageContextMenu: () => null }))
vi.mock('./ProcessingTimeline', () => ({ ProcessingTimeline: () => null }))

describe('conversation waiting and streaming presentation (PC contract)', () => {
  let renderer: ReactTestRenderer | null = null
  const user: ChatMessage = {
    id: 'user',
    role: 'user',
    content: 'Hello',
    status: 'completed',
    createdAt: 1,
  }
  const assistant: ChatMessage = {
    id: 'assistant',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: 2,
  }

  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = null
    vi.unstubAllGlobals()
  })

  async function render(messages: ChatMessage[], running = true) {
    const element = (
      <MessageList
        bottomInset={0}
        conversationId="task"
        entryRevision={1}
        hasMoreBefore={false}
        messages={messages}
        loading={false}
        loadingMoreBefore={false}
        running={running}
        onLoadMoreBefore={async () => {}}
        topInset={0}
      />
    )
    await act(() => {
      if (renderer) renderer.update(element)
      else renderer = create(element)
    })
  }

  const indicators = () =>
    renderer!.root.findAll(
      node =>
        node.type === ('Text' as React.ElementType) && node.props.testID === 'thinking-indicator'
    )

  it.each(['new', 'existing'])(
    'shows thinking before the first event in a %s conversation',
    async kind => {
      const history: ChatMessage[] =
        kind === 'existing'
          ? [{ ...assistant, id: 'previous', content: 'Previous reply', status: 'completed' }]
          : []
      await render([...history, user])
      expect(indicators()).toHaveLength(1)
      expect(indicators()[0].props.children).toBe('思考中')
      await render([...history, user], false)
      expect(indicators()).toHaveLength(0)
    }
  )

  it('replaces waiting with each text delta instead of waiting for completion', async () => {
    await render([user, assistant])
    expect(indicators()).toHaveLength(1)
    await render([user, { ...assistant, content: '你' }])
    expect(indicators()).toHaveLength(0)
    expect(renderer!.root.findByType('AssistantMarkdown' as never).props.children).toBe('你')
    await render([user, { ...assistant, content: '你好' }])
    expect(renderer!.root.findByType('AssistantMarkdown' as never).props.children).toBe('你好')
  })

  it('shows reasoning while streaming, then hides it on completion', async () => {
    await render([user, { ...assistant, streamingThinkingContent: 'Checking the request' }])
    expect(indicators()).toHaveLength(1)
    expect(indicators()[0].props.children).toContain('Checking the request')
    await render([user, { ...assistant, content: 'Done', status: 'completed' }], false)
    expect(indicators()).toHaveLength(0)
  })
})
