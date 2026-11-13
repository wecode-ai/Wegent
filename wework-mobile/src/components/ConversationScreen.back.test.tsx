import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationScreen } from './ConversationScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const environment = vi.hoisted(() => ({
  focused: true,
  platform: 'android',
  backHandlers: new Set<() => boolean>(),
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
vi.mock('./KeyboardSafeInput', () => ({
  KeyboardSafeView: 'KeyboardSafeView',
  useKeyboardVisible: () => false,
}))
vi.mock('./MessageList', () => ({ MessageList: 'MessageList' }))
vi.mock('./QuickModelSelector', () => ({
  QuickModelDismissLayer: 'QuickDismiss',
  QuickModelSelector: 'QuickSelector',
}))

describe('Android quick model back navigation', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    environment.focused = true
    environment.platform = 'android'
    environment.backHandlers.clear()
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
})
