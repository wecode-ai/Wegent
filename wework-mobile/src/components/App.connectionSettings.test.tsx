import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const logout = vi.hoisted(() => vi.fn())
const runtime = vi.hoisted(() => ({
  work: { projects: [], chats: [] },
  messages: [],
  currentAddress: null as { deviceId: string; taskId: string } | null,
  selectedWorkspace: null,
  devices: [],
  clearError: vi.fn(),
  refresh: vi.fn(),
  archiveConversation: vi.fn(),
  openConversation: vi.fn(),
  startNewConversation: vi.fn(),
}))
const navigation = vi.hoisted(() => ({
  currentRouteKey: 'conversation-1',
  conversationRouteKey: 'conversation-1',
  goBack: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock('@/auth/useWegentAuth', () => ({
  useWegentAuth: () => ({
    status: 'authenticated',
    config: {
      backendUrl: 'https://backend.example.com',
      apiBaseUrl: 'https://backend.example.com/api',
    },
    user: { id: 1, full_name: 'Test account' },
    logout,
  }),
}))
vi.mock('@/hooks/useMobileRuntime', () => ({
  useMobileRuntime: () => ({ ...runtime }),
}))
vi.mock('@/services/chatLayoutDiagnostics', () => ({ recordChatLayoutDiagnostic: vi.fn() }))
vi.mock('@/theme', () => ({ lightTheme: {}, darkTheme: {} }))
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles },
  useColorScheme: () => 'light',
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: 'SafeAreaProvider',
  SafeAreaView: 'SafeAreaView',
}))
vi.mock('react-native-keyboard-controller', () => ({ KeyboardProvider: 'KeyboardProvider' }))
vi.mock('@react-navigation/native', () => ({ NavigationContainer: 'NavigationContainer' }))
vi.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({
    Navigator: 'Navigator',
    Screen: ({
      children,
      name,
    }: {
      children: (value: object) => React.ReactNode
      name: string
    }) => {
      const routeKey = name === 'conversation' ? navigation.conversationRouteKey : name
      return children({
        navigation: {
          goBack: navigation.goBack,
          navigate: navigation.navigate,
          isFocused: () => navigation.currentRouteKey === routeKey,
        },
      })
    },
  }),
}))
vi.mock('react-native-paper', () => {
  const Dialog = Object.assign(
    ({ children, ...props }: { children: React.ReactNode }) =>
      React.createElement('Dialog', props, children),
    { Title: 'DialogTitle', Content: 'DialogContent', Actions: 'DialogActions' }
  )
  return {
    Dialog,
    PaperProvider: 'PaperProvider',
    Portal: 'Portal',
    Snackbar: 'Snackbar',
    Text: 'Text',
    useTheme: () => ({ dark: false, colors: {} }),
  }
})
vi.mock('@/components/AuthorizationScreen', () => ({ AuthorizationScreen: 'AuthorizationScreen' }))
vi.mock('@/components/ConversationListScreen', () => ({
  ConversationListScreen: 'ConversationListScreen',
}))
vi.mock('@/components/ConversationScreen', () => ({ ConversationScreen: 'ConversationScreen' }))
vi.mock('@/components/LiquidGlass', () => ({ LiquidGlassButton: 'LiquidGlassButton' }))
vi.mock('@/components/ModelPickerDialog', () => ({ ModelPickerScreen: 'ModelPickerScreen' }))
vi.mock('@/components/ProjectDialog', () => ({ ProjectDialog: 'ProjectDialog' }))
vi.mock('@/components/files/FilePreviewProvider', () => ({
  FilePreviewProvider: 'FilePreviewProvider',
}))

describe('connection settings remain available through the conversation menu', () => {
  let renderer: ReactTestRenderer
  const dialog = () => renderer.root.findByType('Dialog' as never)
  const button = (testID: string) => renderer.root.findByProps({ testID })
  beforeEach(async () => {
    logout.mockReset()
    runtime.currentAddress = null
    await act(() => {
      renderer = create(<App />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })

  it('opens the existing connection dialog with the backend and account', async () => {
    expect(dialog().props.visible).toBe(false)
    const conversation = renderer.root.findByType('ConversationScreen' as never)
    await act(() => conversation.props.conversationActions.onSettings())
    expect(dialog().props.visible).toBe(true)
    const content = dialog()
      .findAllByType('Text' as never)
      .map(node => node.props.children)
    expect(content).toContain('https://backend.example.com')
    expect(content).toContain('Test account')
    await act(() => button('close-settings').props.onPress())
    expect(dialog().props.visible).toBe(false)
  })

  it('retains the original sign-out operation from the restored dialog', async () => {
    const conversation = renderer.root.findByType('ConversationScreen' as never)
    await act(() => conversation.props.conversationActions.onSettings())
    await act(() => button('disconnect-backend').props.onPress())
    expect(logout).toHaveBeenCalledOnce()
    expect(dialog().props.visible).toBe(false)
  })
})

describe('conversation archive navigation', () => {
  let renderer: ReactTestRenderer
  const address = { deviceId: 'device', taskId: 'task' }
  const conversation = () => renderer.root.findByType('ConversationScreen' as never)
  const list = () => renderer.root.findByType('ConversationListScreen' as never)

  beforeEach(async () => {
    vi.clearAllMocks()
    runtime.currentAddress = address
    navigation.currentRouteKey = 'conversation-1'
    navigation.conversationRouteKey = 'conversation-1'
    navigation.goBack.mockImplementation(() => {
      navigation.currentRouteKey = 'conversationList'
    })
    navigation.navigate.mockImplementation(() => {
      navigation.currentRouteKey = navigation.conversationRouteKey
    })
    runtime.startNewConversation.mockImplementation(() => {
      runtime.currentAddress = null
    })
    runtime.openConversation.mockImplementation(item => {
      runtime.currentAddress = item.address
    })
    await act(() => {
      renderer = create(<App />)
    })
  })

  afterEach(async () => {
    await act(() => renderer.unmount())
  })

  async function beginArchive() {
    let complete!: () => void
    runtime.archiveConversation.mockReturnValue(
      new Promise<void>(resolve => {
        complete = resolve
      })
    )
    let pending!: Promise<void>
    await act(() => {
      pending = conversation().props.conversationActions.onArchive()
    })
    expect(runtime.archiveConversation).toHaveBeenCalledWith(address)
    return () =>
      act(async () => {
        complete()
        await pending
      })
  }

  it('returns to the list after the active archive clears its conversation', async () => {
    const complete = await beginArchive()
    runtime.currentAddress = null
    await act(() => renderer.update(<App />))
    await complete()
    expect(navigation.goBack).toHaveBeenCalledOnce()
  })

  it('keeps a new conversation opened in the same route while the old archive is pending', async () => {
    const complete = await beginArchive()
    await act(() => conversation().props.onNewConversation())
    expect(runtime.startNewConversation).toHaveBeenCalledOnce()
    expect(navigation.currentRouteKey).toBe('conversation-1')
    await complete()
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it.each(['task', 'another-task'])(
    'keeps the next visit to %s after returning to the list',
    async taskId => {
      const complete = await beginArchive()
      await act(() => conversation().props.onBack())
      navigation.conversationRouteKey = 'conversation-2'
      await act(() => list().props.onSelectConversation({ address: { ...address, taskId } }))
      await complete()
      expect(navigation.goBack).toHaveBeenCalledOnce()
      expect(navigation.currentRouteKey).toBe('conversation-2')
    }
  )

  it('keeps a new conversation opened from the list after returning during archive', async () => {
    const complete = await beginArchive()
    await act(() => conversation().props.onBack())
    await act(() => list().props.onNewConversation())
    await complete()
    expect(navigation.goBack).toHaveBeenCalledOnce()
    expect(navigation.currentRouteKey).toBe('conversation-1')
  })

  it('does not pop another screen that is focused when the archive finishes', async () => {
    const complete = await beginArchive()
    navigation.currentRouteKey = 'modelPicker'
    await complete()
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it('preserves archive failures without navigating', async () => {
    runtime.archiveConversation.mockRejectedValue(new Error('Device offline'))
    await act(async () => {
      await expect(conversation().props.conversationActions.onArchive()).rejects.toThrow(
        'Device offline'
      )
    })
    expect(navigation.goBack).not.toHaveBeenCalled()
  })
})
