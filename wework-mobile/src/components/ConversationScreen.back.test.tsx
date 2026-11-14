import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationScreen } from './ConversationScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const environment = vi.hoisted(() => ({
  focused: true,
  platform: 'android',
  backHandlers: new Set<() => boolean>(),
  composerInset: { value: 0 },
}))

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('@react-navigation/native', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffect(() => (environment.focused ? effect() : undefined), [effect, environment.focused]),
  }
})
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    addEventListener: () => ({ remove: vi.fn() }),
    isReduceMotionEnabled: async () => false,
  },
  Animated: {
    Value: class {
      interpolate() {
        return 0
      }
    },
    View: 'AnimatedView',
  },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      environment.backHandlers.add(handler)
      return { remove: () => environment.backHandlers.delete(handler) }
    },
  },
  Keyboard: { dismiss: vi.fn() },
  Modal: 'Modal',
  Platform: {
    get OS() {
      return environment.platform
    },
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ dark: false, colors: {} }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16 }),
}))
vi.mock('./ChatComposer', async () => {
  const { createElement, useState } = await import('react')
  return {
    ChatComposer: ({ onSelectModel }: { onSelectModel: () => void }) => {
      const [draft, setDraft] = useState('')
      return createElement('Composer', { draft, onChangeText: setDraft, onSelectModel })
    },
  }
})
vi.mock('./ConversationEdgeMask', () => ({ ConversationEdgeMask: 'EdgeMask' }))
vi.mock('./ConversationHeader', () => ({
  ConversationHeader: 'Header',
  CONVERSATION_HEADER_HEIGHT: 44,
}))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardGestureArea: 'KeyboardGestureArea',
  KeyboardStickyView: 'KeyboardStickyView',
}))
vi.mock('@legendapp/list/keyboard', () => ({
  useKeyboardChatComposerInset: () => ({
    contentInsetEndAdjustment: environment.composerInset,
    onComposerLayout: (event: { nativeEvent: { layout: { height: number } } }) => {
      environment.composerInset.value = event.nativeEvent.layout.height
    },
  }),
}))
vi.mock('./MessageList', async () => {
  const { createElement } = await import('react')
  return {
    MessageList: (props: { configuration?: React.ReactElement }) =>
      createElement('MessageList', props, props.configuration),
  }
})
vi.mock('./QuickModelSelector', () => ({
  QuickModelDismissLayer: 'QuickDismiss',
  QuickModelSelector: 'QuickSelector',
}))

describe('conversation keyboard layout and model navigation', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    environment.focused = true
    environment.platform = 'android'
    environment.backHandlers.clear()
    environment.composerInset.value = 0
  })

  const props = (): React.ComponentProps<typeof ConversationScreen> => ({
    currentAddress: null,
    currentTitle: '',
    devices: [],
    entryRevision: 0,
    gitRef: null,
    hasMoreMessagesBefore: false,
    isNew: true,
    loading: false,
    loadingMoreMessagesBefore: false,
    messages: [],
    model: null,
    modelOptions: {},
    permissionMode: 'workspace-write',
    selectedDeviceId: null,
    selectedProjectName: null,
    selectedWorkspace: null,
    running: false,
    sending: false,
    stopping: false,
    workspaces: [],
    onBack: vi.fn(),
    onLoadApps: vi.fn(),
    onLoadMoreMessagesBefore: vi.fn(),
    onMore: vi.fn(),
    onNewConversation: vi.fn(),
    onOpenAdvancedModel: vi.fn(),
    onSelectDevice: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectPermissionMode: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onUploadAttachment: vi.fn(),
  })
  const composer = () => renderer.root.findByType('Composer' as never)
  const quick = () => renderer.root.findAllByType('QuickSelector' as never)

  it('consumes back to close only the quick layer and keeps the composer draft mounted', async () => {
    const handlers = props()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    expect(environment.backHandlers.size).toBe(0)
    await act(() => composer().props.onChangeText('Keep this draft'))
    await act(() => composer().props.onSelectModel())
    expect(quick()).toHaveLength(1)
    let consumed = false
    await act(() => {
      consumed = [...environment.backHandlers][0]!()
    })
    expect(consumed).toBe(true)
    expect(quick()).toHaveLength(0)
    expect(composer().props.draft).toBe('Keep this draft')
    expect(handlers.onBack).not.toHaveBeenCalled()
    expect(environment.backHandlers.size).toBe(0)
  })

  it('does not intercept back for an unfocused screen or the advanced navigation modal', async () => {
    const handlers = props()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await act(() => composer().props.onSelectModel())
    expect(environment.backHandlers.size).toBe(1)
    environment.focused = false
    await act(() => renderer.update(<ConversationScreen {...handlers} />))
    expect(environment.backHandlers.size).toBe(0)
    environment.focused = true
    await act(() => renderer.update(<ConversationScreen {...handlers} />))
    expect(environment.backHandlers.size).toBe(1)
    await act(() => quick()[0]!.props.onOpenAdvanced())
    expect(handlers.onOpenAdvancedModel).toHaveBeenCalledOnce()
    expect(environment.backHandlers.size).toBe(0)
  })

  it('does not register Android handlers on iOS', async () => {
    environment.platform = 'ios'
    await act(() => {
      renderer = create(<ConversationScreen {...props()} />)
    })
    await act(() => composer().props.onSelectModel())
    expect(quick()).toHaveLength(1)
    expect(environment.backHandlers.size).toBe(0)
  })

  it.each(['ios', 'android'])('reserves the measured composer once on %s', async platform => {
    environment.platform = platform
    await act(() => {
      renderer = create(<ConversationScreen {...props()} isNew={false} />)
    })
    const dock = renderer.root.findByProps({ testID: 'conversation-composer-dock' })
    const list = renderer.root.findByType('MessageList' as never)
    expect(list.props.keyboardOffset).toBe(16)
    expect(dock.props.offset).toEqual({ opened: 16 })
    expect(list.props.contentInsetEndAdjustment).toBe(environment.composerInset)
    await act(() => dock.props.onLayout({ nativeEvent: { layout: { height: 124 } } }))
    expect(list.props.contentInsetEndAdjustment.value).toBe(124)
    await act(() => dock.props.onLayout({ nativeEvent: { layout: { height: 188 } } }))
    expect(list.props.contentInsetEndAdjustment.value).toBe(188)
    expect(list.props.bottomInset).toBeUndefined()
  })

  it('changes the list data key on re-entry without remounting the list or losing the draft', async () => {
    const screenProps = { ...props(), isNew: false }
    await act(() => {
      renderer = create(<ConversationScreen {...screenProps} />)
    })
    const previousList = renderer.root.findByType('MessageList' as never)
    const previousDataKey = previousList.props.dataKey
    await act(() => composer().props.onChangeText('Keep this draft'))
    await act(() => renderer.update(<ConversationScreen {...screenProps} entryRevision={1} />))
    const currentList = renderer.root.findByType('MessageList' as never)
    expect(currentList).toBe(previousList)
    expect(currentList.props.dataKey).not.toBe(previousDataKey)
    expect(composer().props.draft).toBe('Keep this draft')
  })

  it('keeps one list through creating a conversation and loading another conversation', async () => {
    const screenProps = props()
    await act(() => {
      renderer = create(<ConversationScreen {...screenProps} />)
    })
    const list = renderer.root.findByType('MessageList' as never)
    const newConversationDataKey = list.props.dataKey
    expect(list.props.configuration.props.testID).toBe('new-chat-configuration')
    await act(() => composer().props.onChangeText('Keep this draft'))

    const existingProps = {
      ...screenProps,
      isNew: false,
      currentAddress: { deviceId: 'remote-executor', taskId: 'created-task' },
      messages: [
        {
          id: 'user-1',
          role: 'user' as const,
          content: 'Hello',
          status: 'completed' as const,
          createdAt: 1,
        },
      ],
    }
    await act(() => renderer.update(<ConversationScreen {...existingProps} />))
    expect(renderer.root.findByType('MessageList' as never)).toBe(list)
    expect(list.props.dataKey).not.toBe(newConversationDataKey)
    expect(list.props.configuration).toBeUndefined()

    await act(() =>
      renderer.update(
        <ConversationScreen
          {...existingProps}
          currentAddress={{ deviceId: 'remote-executor', taskId: 'other-task' }}
          loading
          messages={[]}
        />
      )
    )
    expect(renderer.root.findByType('MessageList' as never)).toBe(list)
    expect(list.props.loading).toBe(true)
    expect(list.props.messages).toEqual([])
    expect(composer().props.draft).toBe('Keep this draft')
  })

  it('provides every new conversation configuration row as one measured list item', async () => {
    const screenProps = props()
    screenProps.devices = [
      {
        id: 1,
        device_id: 'remote-executor',
        name: 'Remote executor',
        status: 'online',
        device_type: 'remote',
        bind_shell: 'claudecode',
      },
    ]
    screenProps.selectedDeviceId = 'remote-executor'
    screenProps.selectedProjectName = 'Cloud project'
    screenProps.selectedWorkspace = {
      deviceId: 'remote-executor',
      deviceName: 'Remote executor',
      deviceStatus: 'online',
      available: true,
      workspacePath: '/workspace/project',
      tasks: [],
    }
    screenProps.gitRef = 'refs/heads/main'
    await act(() => {
      renderer = create(<ConversationScreen {...screenProps} />)
    })
    const list = renderer.root.findByType('MessageList' as never)
    const configuration = list.findByProps({ testID: 'new-chat-configuration' })
    expect(configuration.props.style.position).toBeUndefined()
    expect(configuration.findAllByType('ScrollView' as never)).toHaveLength(0)
    expect(configuration.findAllByType('KeyboardStickyView' as never)).toHaveLength(0)
    for (const testID of [
      'new-chat-device',
      'new-chat-project',
      'new-chat-work-mode',
      'new-chat-branch',
    ]) {
      expect(configuration.findByProps({ testID })).toBeDefined()
    }
    const dock = renderer.root.findByProps({ testID: 'conversation-composer-dock' })
    await act(() => dock.props.onLayout({ nativeEvent: { layout: { height: 240 } } }))
    expect(list.props.contentInsetEndAdjustment.value).toBe(240)
    expect(list.findByProps({ testID: 'new-chat-configuration' })).toBe(configuration)
  })
})
