import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const logout = vi.hoisted(() => vi.fn())
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
  useMobileRuntime: () => ({
    work: { projects: [], chats: [] },
    messages: [],
    currentAddress: null,
    selectedWorkspace: null,
    devices: [],
    clearError: vi.fn(),
    refresh: vi.fn(),
  }),
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
    Screen: ({ children }: { children: (value: object) => React.ReactNode }) =>
      children({ navigation: { goBack: vi.fn(), navigate: vi.fn() } }),
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
