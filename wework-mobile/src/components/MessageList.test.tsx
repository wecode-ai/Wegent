import { KeyboardAwareLegendList } from '@legendapp/list/keyboard'
import type { LegendListRef } from '@legendapp/list/react-native'
import React, { type ComponentProps, type ReactNode, type RefObject } from 'react'
import { StyleSheet, View } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requestUserInputPayloadKey } from '@/domain/requestUserInput'
import type { ChatMessage } from '@/types/runtime'
import { MessageList } from './MessageList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const boundary = vi.hoisted(() => ({
  list: vi.fn(),
  useKeyboardScrollToEnd: vi.fn(),
  scrollMessageToEnd: vi.fn(async () => {}),
  timeline: vi.fn(),
}))

interface ListBoundaryProps {
  data: { id: string }[]
  renderItem: (value: { item: { id: string }; index: number }) => ReactNode
  ListHeaderComponent?: ReactNode
  ListFooterComponent?: ReactNode
  ListEmptyComponent?: ReactNode
  testID?: string
}

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('react-native', () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (style: unknown) =>
      Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style,
  },
  View: 'View',
  Pressable: 'Pressable',
}))
vi.mock('@legendapp/list/keyboard', () => ({
  KeyboardAwareLegendList: (props: ListBoundaryProps) => {
    boundary.list(props)
    return (
      <View testID={props.testID}>
        {props.ListHeaderComponent}
        {!props.data.length ? props.ListEmptyComponent : null}
        {props.data.map((item, index) => (
          <React.Fragment key={item.id}>{props.renderItem({ item, index })}</React.Fragment>
        ))}
        {props.ListFooterComponent}
      </View>
    )
  },
  useKeyboardScrollToEnd: (options: unknown) => {
    boundary.useKeyboardScrollToEnd(options)
    return { freeze: { value: false }, scrollMessageToEnd: boundary.scrollMessageToEnd }
  },
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
  useTheme: () => ({ colors: { surfaceVariant: 'gray', onSurfaceVariant: 'gray' } }),
}))
vi.mock('./AssistantMarkdown', () => ({ AssistantMarkdown: 'AssistantMarkdown' }))
vi.mock('./MessageContextMenu', () => ({ MessageContextMenu: 'MessageContextMenu' }))
vi.mock('./ProcessingTimeline', () => ({
  ProcessingTimeline: (props: { message: ChatMessage }) => {
    boundary.timeline(props)
    return null
  },
}))

type RenderOptions = Partial<Omit<ComponentProps<typeof MessageList>, 'messages'>>

describe('conversation waiting, streaming and native list integration (PC contract)', () => {
  let renderer: ReactTestRenderer | null = null
  let listRef: RefObject<LegendListRef | null>
  let contentInsetEndAdjustment: SharedValue<number>
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
    vi.clearAllMocks()
    listRef = { current: null }
    contentInsetEndAdjustment = { value: 80 } as SharedValue<number>
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = null
  })

  async function render(messages: ChatMessage[], options: RenderOptions = {}) {
    const element = (
      <MessageList
        dataKey="device:task:1"
        listRef={listRef}
        keyboardOffset={8}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        hasMoreBefore={false}
        messages={messages}
        loading={false}
        loadingMoreBefore={false}
        running
        onLoadMoreBefore={loadMoreBefore}
        topInset={0}
        {...options}
      />
    )
    await act(() => {
      if (renderer) renderer.update(element)
      else renderer = create(element)
    })
  }

  const loadMoreBefore = async () => {}
  const list = () => boundary.list.mock.lastCall![0]
  const listInstance = () => renderer!.root.findByType(KeyboardAwareLegendList)
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
      await render([...history, user], { running: false })
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
    await render([user, { ...assistant, content: 'Done', status: 'completed' }], { running: false })
    expect(indicators()).toHaveLength(0)
  })

  it.each(['user-history', 'assistant-only'])(
    'asks the keyboard-aware list to reveal an appended user message after %s',
    async kind => {
      const finished: ChatMessage = { ...assistant, content: 'Done', status: 'completed' }
      const history = kind === 'user-history' ? [user, finished] : [finished]
      const followup = { ...user, id: 'followup', content: 'Continue', createdAt: 3 }
      await render(history, { running: false })
      expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()

      await render([...history, followup])
      expect(boundary.scrollMessageToEnd).toHaveBeenCalledExactlyOnceWith({
        animated: true,
        closeKeyboard: false,
      })
      expect(boundary.useKeyboardScrollToEnd).toHaveBeenLastCalledWith({ listRef })

      await render([...history, followup, { ...assistant, id: 'next-assistant' }])
      expect(boundary.scrollMessageToEnd).toHaveBeenCalledOnce()
    }
  )

  it('does not take over scrolling when older user messages are prepended', async () => {
    await render([assistant], { hasMoreBefore: true })
    const older = { ...user, id: 'older-user', createdAt: 0 }
    await render([older, assistant], { hasMoreBefore: true })
    await render([{ ...older, id: 'oldest-user', createdAt: -1 }, older, assistant])

    expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()
    expect(list().maintainVisibleContentPosition).toBeTruthy()
  })

  it('reveals a user turn when its assistant placeholder arrives in the same update', async () => {
    const history: ChatMessage[] = [user, { ...assistant, status: 'completed', content: 'Done' }]
    await render(history, { running: false })
    await render([
      ...history,
      { ...user, id: 'followup', createdAt: 3 },
      { ...assistant, id: 'next-assistant', createdAt: 4 },
    ])

    expect(boundary.scrollMessageToEnd).toHaveBeenCalledExactlyOnceWith({
      animated: true,
      closeKeyboard: false,
    })
  })

  it('lets the list position asynchronously loaded history without treating it as a send', async () => {
    await render([], { loading: true, running: false })
    await render([user, { ...assistant, content: 'Saved reply', status: 'completed' }], {
      running: false,
    })

    expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()
    expect(list().initialScrollAtEnd).toBe(true)
  })

  it('keeps the keyboard list mounted across draft, loading and populated datasets', async () => {
    const configuration = <View testID="new-chat-configuration" />
    await render([], { running: false, configuration, topInset: 116 })
    const mountedList = listInstance()
    expect(list().data).toEqual([{ kind: 'configuration', id: 'new-conversation-configuration' }])
    expect(renderer!.root.findAllByProps({ testID: 'new-chat-configuration' })).toHaveLength(1)
    expect(list().alignItemsAtEnd).toBe(true)
    expect(list().initialScrollAtEnd).toBe(true)
    expect(list().extraData).toMatchObject({ configuration, loading: false })
    const configurationStyle = StyleSheet.flatten(list().contentContainerStyle)
    expect(configurationStyle).toMatchObject({ paddingTop: 116, paddingBottom: 20 })
    expect(configurationStyle).not.toHaveProperty('flexGrow')
    expect(configurationStyle).not.toHaveProperty('paddingHorizontal')
    expect(boundary.timeline).not.toHaveBeenCalled()

    await render([], {
      dataKey: 'device:other-task:1',
      loading: true,
      running: false,
      configuration,
    })
    expect(listInstance()).toBe(mountedList)
    expect(list().extraData).toMatchObject({ configuration, loading: true })
    expect(renderer!.root.findAllByType('ActivityIndicator' as never)).toHaveLength(1)
    expect(renderer!.root.findAllByProps({ testID: 'new-chat-configuration' })).toHaveLength(0)

    const messages: ChatMessage[] = [
      user,
      { ...assistant, content: 'Saved reply', status: 'completed' },
    ]
    await render(messages, {
      dataKey: 'device:other-task:1',
      running: false,
    })
    expect(listInstance()).toBe(mountedList)
    expect(renderer!.root.findAllByType('ActivityIndicator' as never)).toHaveLength(0)
    expect(list().dataKey).toBe('device:other-task:1')
    expect(list().data).toBe(messages)
    expect(list().alignItemsAtEnd).toBe(false)
    expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()

    await render([], { dataKey: 'new:device:1', running: false, configuration })
    expect(listInstance()).toBe(mountedList)
    expect(list().data).toHaveLength(1)
    expect(renderer!.root.findAllByProps({ testID: 'new-chat-configuration' })).toHaveLength(1)
    expect(list().alignItemsAtEnd).toBe(true)
  })

  it('reveals the first user message when it replaces the configuration row', async () => {
    const configuration = <View testID="new-chat-configuration" />
    await render([], { running: false, configuration })
    const mountedList = listInstance()
    await render([user])

    expect(listInstance()).toBe(mountedList)
    expect(list().data).toEqual([user])
    expect(list().alignItemsAtEnd).toBe(false)
    expect(renderer!.root.findAllByProps({ testID: 'new-chat-configuration' })).toHaveLength(0)
    expect(boundary.scrollMessageToEnd).toHaveBeenCalledExactlyOnceWith({
      animated: true,
      closeKeyboard: false,
    })
  })

  it('invalidates the list render cache when configuration changes with stable data', async () => {
    const initial = <View testID="initial-configuration" />
    await render([], { running: false, configuration: initial })
    const configurationData = list().data
    const extraData = list().extraData
    const updated = <View testID="updated-configuration" />
    await render([], { running: false, configuration: updated })

    expect(list().data).toBe(configurationData)
    expect(list().extraData).not.toBe(extraData)
    expect(list().extraData.configuration).toBe(updated)
    expect(renderer!.root.findAllByProps({ testID: 'initial-configuration' })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ testID: 'updated-configuration' })).toHaveLength(1)
  })

  it('passes pending input identities and handlers through list extraData', async () => {
    const payload = { kind: 'request_user_input' as const, requestId: 'question-1', questions: [] }
    const pending: ChatMessage = {
      ...assistant,
      blocks: [
        {
          id: 'question',
          subtaskId: 'turn-one',
          type: 'tool',
          toolName: 'request_user_input',
          createdAt: 2,
          status: 'pending',
          renderPayload: payload,
        },
      ],
    }
    const handlers = {
      onRequestUserInputSubmit: vi.fn(async () => true),
      onRequestUserInputSkip: vi.fn(async () => true),
    }
    await render([user, pending], handlers)
    expect(list().extraData).toMatchObject(handlers)
    expect(list().extraData.pendingInputKeys).toEqual(
      new Set([requestUserInputPayloadKey(payload)])
    )

    const answeredMessages = [user, pending, { ...user, id: 'answer', createdAt: 3 }]
    await render(answeredMessages, handlers)
    expect(list().extraData.pendingInputKeys).toEqual(new Set())
    expect(boundary.timeline.mock.lastCall![0].pendingInputKeys).toEqual(new Set())

    const onRequestUserInputSubmit = vi.fn(async () => false)
    await render(answeredMessages, { ...handlers, onRequestUserInputSubmit })
    expect(list().data).toBe(answeredMessages)
    expect(list().extraData.onRequestUserInputSubmit).toBe(onRequestUserInputSubmit)
  })

  it.each([true, false])(
    'follows streaming row growth immediately when running=%s',
    async running => {
      await render([user, assistant], { running })
      for (const content of [
        'First line',
        'First line\n\nSecond line',
        'First line\n\nSecond line\n\nDone',
      ]) {
        await render([user, { ...assistant, content }], { running })
        expect(list().maintainScrollAtEnd).toMatchObject({ animated: false })
      }
      await render(
        [user, { ...assistant, content: 'First line\n\nSecond line\n\nDone', status: 'completed' }],
        {
          running: false,
        }
      )

      expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()
      expect(list().maintainScrollAtEnd).toMatchObject({ animated: false })
      expect(list().onContentSizeChange).toBeUndefined()
    }
  )

  it('passes the measured composer inset and keyboard offset to the same list ref', async () => {
    await render([user, assistant], { keyboardOffset: 12, topInset: 116 })
    expect(list().ref).toBe(listRef)
    expect(list().keyboardOffset).toBe(12)
    expect(list().contentInsetEndAdjustment).toBe(contentInsetEndAdjustment)
    expect(StyleSheet.flatten(list().contentContainerStyle)).toMatchObject({
      paddingTop: 116,
      paddingBottom: 20,
    })

    contentInsetEndAdjustment.value = 160
    await render([user, assistant], { keyboardOffset: 0, topInset: 116 })
    expect(list().contentInsetEndAdjustment).toBe(contentInsetEndAdjustment)
    expect(list().contentInsetEndAdjustment.value).toBe(160)
    expect(list().keyboardOffset).toBe(0)
    expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()
  })

  it('resets message and menu state by dataset key without remounting the keyboard list', async () => {
    const history: ChatMessage[] = [
      user,
      { ...assistant, content: 'First answer', status: 'completed' },
    ]
    await render(history)
    const mountedList = listInstance()
    const message = renderer!.root.findByProps({ testID: 'message-user' })
    await act(() => message.props.onLongPress({ nativeEvent: { pageX: 20, pageY: 40 } }))
    expect(renderer!.root.findByType('MessageContextMenu' as never).props.anchor).toEqual({
      x: 20,
      y: 40,
    })

    const loadedUser = { ...user, id: 'loaded-user', createdAt: 5 }
    await render([...history, loadedUser], { dataKey: 'device:other-task:1' })
    expect(listInstance()).toBe(mountedList)
    expect(list().dataKey).toBe('device:other-task:1')
    expect(renderer!.root.findByType('MessageContextMenu' as never).props.anchor).toBeNull()
    expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()
    await render([...history, loadedUser], { dataKey: 'device:other-task:2' })
    expect(listInstance()).toBe(mountedList)
    expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()

    await render([...history, loadedUser, { ...user, id: 'fresh-send', createdAt: 6 }], {
      dataKey: 'device:other-task:2',
    })
    expect(boundary.scrollMessageToEnd).toHaveBeenCalledOnce()
  })

  it('keeps unchanged historical messages out of streaming rerenders', async () => {
    const history: ChatMessage = {
      ...assistant,
      id: 'history',
      content: 'Previous reply',
      status: 'completed',
    }
    const currentUser = { ...user, id: 'current-user', createdAt: 3 }
    await render([user, history, currentUser, assistant])
    boundary.timeline.mockClear()

    for (const content of ['A', 'An answer', 'An answer with more text']) {
      await render([user, history, currentUser, { ...assistant, content }])
    }

    expect(boundary.timeline.mock.calls.map(([props]) => props.message.id)).toEqual([
      'assistant',
      'assistant',
      'assistant',
    ])
  })

  it('does not load history from initial layout before a real user scroll', async () => {
    const onLoadMoreBefore = vi.fn(async () => {})
    listRef.current = { getState: () => ({ isAtStart: true }) } as unknown as LegendListRef
    await render([user, assistant], { hasMoreBefore: true, onLoadMoreBefore })
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).not.toHaveBeenCalled()

    await act(() => list().onUserScroll())
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()

    await render([user, assistant], {
      dataKey: 'device:other-task:1',
      hasMoreBefore: true,
      onLoadMoreBefore,
    })
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()
  })

  it('waits until the user reaches the start before loading previous pages', async () => {
    const onLoadMoreBefore = vi.fn(async () => {})
    listRef.current = { getState: () => ({ isAtStart: false }) } as unknown as LegendListRef
    await render([user, assistant], { hasMoreBefore: true, onLoadMoreBefore })
    await act(() => list().onUserScroll())
    expect(onLoadMoreBefore).not.toHaveBeenCalled()

    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()
  })

  it('does not let an old conversation page request release the new conversation loading lock', async () => {
    let finishOldRequest!: () => void
    let finishNewRequest!: () => void
    const oldRequest = new Promise<void>(resolve => {
      finishOldRequest = resolve
    })
    const newRequest = new Promise<void>(resolve => {
      finishNewRequest = resolve
    })
    const onLoadMoreBefore = vi
      .fn()
      .mockImplementationOnce(() => oldRequest)
      .mockImplementationOnce(() => newRequest)
      .mockResolvedValue(undefined)
    const options = { hasMoreBefore: true, onLoadMoreBefore }
    await render([user, assistant], options)
    await act(() => list().onUserScroll())
    let oldLoad!: Promise<void>
    await act(() => {
      oldLoad = list().onStartReached()
    })
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()

    await render([user, assistant], { ...options, dataKey: 'device:other-task:1' })
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()
    await act(() => list().onUserScroll())
    let newLoad!: Promise<void>
    await act(() => {
      newLoad = list().onStartReached()
    })
    expect(onLoadMoreBefore).toHaveBeenCalledTimes(2)

    await act(async () => {
      finishOldRequest()
      await oldLoad
    })
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledTimes(2)

    await act(async () => {
      finishNewRequest()
      await newLoad
    })
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledTimes(3)
  })

  it('loads previous pages only while more history is available and no load is active', async () => {
    const onLoadMoreBefore = vi.fn(async () => {})
    await render([user, assistant], { hasMoreBefore: true, onLoadMoreBefore })
    await act(() => list().onUserScroll())
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()

    await render([user, assistant], {
      hasMoreBefore: true,
      loadingMoreBefore: true,
      onLoadMoreBefore,
    })
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()
    expect(renderer!.root.findAllByProps({ testID: 'older-messages-loader' })).toHaveLength(1)

    await render([user, assistant], { hasMoreBefore: false, onLoadMoreBefore })
    await act(() => list().onStartReached())
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()
    expect(boundary.scrollMessageToEnd).not.toHaveBeenCalled()
  })
})
