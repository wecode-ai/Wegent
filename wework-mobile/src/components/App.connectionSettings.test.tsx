vi.mock('@/components/ArchivedConversationsScreen', () => ({
  ArchivedConversationsScreen: 'ArchivedConversationsScreen',
}))
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const logout = vi.hoisted(() => vi.fn())
const authState = vi.hoisted(() => ({
  current: {
    status: 'authenticated',
    config: {
      backendUrl: 'https://backend.example.com',
      apiBaseUrl: 'https://backend.example.com/api',
    } as object | null,
    user: { id: 1, full_name: 'Test account' } as object | null,
  },
}))
const runtime = vi.hoisted(() => ({
  work: { projects: [], chats: [] },
  taskRunningByKey: new Map<string, boolean>(),
  messages: [],
  currentAddress: null as { deviceId: string; taskId: string } | null,
  selectedWorkspace: null,
  devices: [],
  clearError: vi.fn(),
  refresh: vi.fn(),
  failures: [] as import('@/hooks/useRuntimeFailures').RuntimeFailureAction[],
  retryFailure: vi.fn(),
  cloudConnected: true,
  connectionError: null as string | null,
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
  useWegentAuth: () => ({ ...authState.current, logout }),
}))
vi.mock('@/hooks/useMobileRuntime', () => ({
  useMobileRuntime: () => ({ ...runtime }),
}))
vi.mock('@/hooks/useLocalRuntime', () => ({
  useLocalRuntime: () => ({
    runtime: {},
    status: { state: 'stopped', supported: false },
    error: null,
  }),
}))
vi.mock('@/components/LocalRuntimeSettings', () => ({
  LocalRuntimeSettings: 'LocalRuntimeSettings',
}))
vi.mock('@/services/phoneLocalModels', () => ({ phoneLocalModels: {} }))
vi.mock('@/components/SettingsScreen', () => ({
  SettingsScreen: 'SettingsScreen',
  LocalExecutionScreen: 'LocalExecutionScreen',
  BackendLoginScreen: 'BackendLoginScreen',
}))
vi.mock('@/components/PhoneModelsScreen', () => ({
  PhoneModelsScreen: 'PhoneModelsScreen',
  PhoneModelEditorScreen: 'PhoneModelEditorScreen',
  CodexAccountScreen: 'CodexAccountScreen',
}))
vi.mock('@/components/PhoneStandaloneModelEditorScreen', () => ({
  PhoneStandaloneModelEditorScreen: 'PhoneStandaloneModelEditorScreen',
}))
vi.mock('@/components/PhoneProviderScreen', () => ({ PhoneProviderScreen: 'PhoneProviderScreen' }))
vi.mock('@/components/PhoneProviderEditorScreen', () => ({
  PhoneProviderEditorScreen: 'PhoneProviderEditorScreen',
}))
vi.mock('@/components/PrivacyPolicyScreen', () => ({ PrivacyPolicyScreen: 'PrivacyPolicyScreen' }))
vi.mock('@/hooks/useMobileDiagnostics', () => ({ useMobileDiagnostics: vi.fn() }))
vi.mock('@/telemetry/mobileTelemetry', () => ({
  mobileTelemetry: { recordStartup: vi.fn(), choose: vi.fn(), recordScreen: vi.fn() },
}))
vi.mock('@/telemetry/useMobileTelemetry', () => ({
  useMobileTelemetryRuntime: () => ({
    ready: false,
    available: false,
    asked: false,
    enabled: false,
    saving: false,
    active: false,
    error: null,
  }),
}))
vi.mock('@/telemetry/useMobileTaskTelemetry', () => ({ useMobileTaskTelemetry: vi.fn() }))
vi.mock('@/components/TelemetryConsentDialog', () => ({
  TelemetryConsentDialog: 'TelemetryConsentDialog',
}))
vi.mock('@/theme', () => ({ lightTheme: {}, darkTheme: {} }))
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
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
        route: {
          params:
            name === 'provider' || name === 'modelEditor' ? { providerId: 'service' } : undefined,
        },
        navigation: {
          goBack: navigation.goBack,
          navigate: navigation.navigate,
          replace: navigation.navigate,
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
    {
      Title: 'DialogTitle',
      Content: 'DialogContent',
      Actions: 'DialogActions',
      ScrollArea: 'DialogScrollArea',
    }
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

describe('local-first settings navigation', () => {
  let renderer: ReactTestRenderer
  beforeEach(async () => {
    runtime.cloudConnected = true
    vi.clearAllMocks()
    authState.current.config = {
      backendUrl: 'https://backend.example.com',
      apiBaseUrl: 'https://backend.example.com/api',
    }
    authState.current.user = { id: 1, full_name: 'Test account' }
    logout.mockReset()
    runtime.currentAddress = null
    await act(() => {
      renderer = create(<App />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })

  it('opens the full-screen settings from the unchanged conversation menu', async () => {
    const conversation = renderer.root.findByType('ConversationScreen' as never)
    await act(() => conversation.props.conversationActions.onSettings())
    expect(navigation.navigate).toHaveBeenCalledWith('settings')
    const settings = renderer.root.findByType('SettingsScreen' as never)
    expect(settings.props.auth.user.full_name).toBe('Test account')
    await act(() => settings.props.onModels())
    expect(navigation.navigate).toHaveBeenLastCalledWith('localModels')
    await act(() => settings.props.onClose())
    expect(navigation.goBack).toHaveBeenCalledOnce()
  })

  it('navigates between provider connections, model details and their editors', async () => {
    const models = renderer.root.findByType('PhoneModelsScreen' as never)
    await act(() => models.props.onAddStandalone())
    expect(navigation.navigate).toHaveBeenLastCalledWith('standaloneModelEditor')
    await act(() => models.props.onEditStandalone('old-model'))
    expect(navigation.navigate).toHaveBeenLastCalledWith('standaloneModelEditor', {
      modelId: 'old-model',
    })
    await act(() => models.props.onAdd())
    expect(navigation.navigate).toHaveBeenLastCalledWith('providerEditor')
    await act(() => models.props.onEdit('service'))
    expect(navigation.navigate).toHaveBeenLastCalledWith('provider', { providerId: 'service' })
    const provider = renderer.root.findByType('PhoneProviderScreen' as never)
    await act(() => provider.props.onAddModel())
    expect(navigation.navigate).toHaveBeenLastCalledWith('modelEditor', { providerId: 'service' })
    await act(() => provider.props.onEditModel('model-a'))
    expect(navigation.navigate).toHaveBeenLastCalledWith('modelEditor', {
      providerId: 'service',
      modelId: 'model-a',
    })
    await act(() => provider.props.onEditConnection())
    expect(navigation.navigate).toHaveBeenLastCalledWith('providerEditor', {
      providerId: 'service',
    })
  })

  it('keeps Backend login optional and hides filters when using only this phone', async () => {
    runtime.cloudConnected = false
    authState.current.config = null
    authState.current.user = null
    await act(() => renderer.update(<App />))
    const list = renderer.root.findByType('ConversationListScreen' as never)
    expect(list.props.showDeviceFilters).toBe(false)
    const settings = renderer.root.findByType('SettingsScreen' as never)
    await act(() => settings.props.onBackend())
    expect(navigation.navigate).toHaveBeenCalledWith('backendLogin')
    expect(renderer.root.findAllByType('AuthorizationScreen' as never)).toHaveLength(0)
    expect(renderer.root.findByType('BackendLoginScreen' as never).props.auth.logout).toBe(logout)
  })

  it('shows device filters after Backend login', () => {
    expect(
      renderer.root.findByType('ConversationListScreen' as never).props.showDeviceFilters
    ).toBe(true)
  })

  it('opens the bundled privacy page from settings and every model entry without Backend login', async () => {
    runtime.cloudConnected = false
    authState.current.config = null
    authState.current.user = null
    await act(() => renderer.update(<App />))
    for (const screen of [
      'SettingsScreen',
      'PhoneModelsScreen',
      'PhoneModelEditorScreen',
      'PhoneStandaloneModelEditorScreen',
      'PhoneProviderScreen',
      'PhoneProviderEditorScreen',
      'CodexAccountScreen',
    ]) {
      await act(() => renderer.root.findByType(screen as never).props.onPrivacy())
      expect(navigation.navigate).toHaveBeenLastCalledWith('privacyPolicy')
    }
    await act(() => renderer.root.findByType('PrivacyPolicyScreen' as never).props.onBack())
    expect(navigation.goBack).toHaveBeenCalledOnce()
    expect(logout).not.toHaveBeenCalled()
  })

  it('routes connection failures to the sidebar instead of the global alert on every screen', async () => {
    runtime.failures = [
      {
        id: 'cloud-connection',
        label: '云端连接',
        error: 'Network unavailable',
        phoneOwned: false,
        retrying: false,
        retry: vi.fn(),
      },
    ]
    await act(() => renderer.update(<App />))
    const list = renderer.root.findByType('ConversationListScreen' as never)
    expect(list.props.failures).toBe(runtime.failures)
    expect(list.props.onRetryFailure).toBe(runtime.retryFailure)
    expect(list.props.onRefresh).toBe(runtime.refresh)
    expect(renderer.root.findAll(node => node.props.error === 'Network unavailable')).toHaveLength(
      0
    )
    runtime.failures = []
  })
})

describe('conversation archive navigation', () => {
  let renderer: ReactTestRenderer
  const address = { deviceId: 'device', taskId: 'task' }
  const conversation = () => renderer.root.findByType('ConversationScreen' as never)
  const list = () => renderer.root.findByType('ConversationListScreen' as never)

  beforeEach(async () => {
    runtime.cloudConnected = true
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

describe('conversation focus request ownership', () => {
  let renderer: ReactTestRenderer
  const conversation = () => renderer.root.findByType('ConversationScreen' as never)
  const list = () => renderer.root.findByType('ConversationListScreen' as never)
  const listeners = () =>
    renderer.root.findByProps({ name: 'conversation' }).props.listeners({
      navigation: {
        isFocused: () => navigation.currentRouteKey === navigation.conversationRouteKey,
      },
    })
  const transition = (closing = false) => listeners().transitionEnd({ data: { closing } })

  beforeEach(async () => {
    runtime.cloudConnected = true
    vi.clearAllMocks()
    runtime.currentAddress = null
    navigation.currentRouteKey = navigation.conversationRouteKey = 'conversation-1'
    runtime.startNewConversation.mockImplementation(() => {
      runtime.currentAddress = null
    })
    await act(() => {
      renderer = create(<App />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })

  it('uses native keyboard dismissal for every stack screen', () => {
    expect(
      renderer.root.findByType('Navigator' as never).props.screenOptions.keyboardHandlingEnabled
    ).toBe(true)
  })

  it('publishes once after entry completes, consumes it, and never replays on the next entry', async () => {
    await act(() => list().props.onNewConversation())
    expect(conversation().props.composerFocusRequest).toBe(0)
    await act(() => transition())
    const first = conversation().props.composerFocusRequest
    expect(first).toBeGreaterThan(0)
    await act(() => conversation().props.onComposerFocusHandled(first))
    expect(conversation().props.composerFocusRequest).toBe(0)
    await act(() => transition())
    expect(conversation().props.composerFocusRequest).toBe(0)
    await act(() => list().props.onNewConversation())
    expect(conversation().props.composerFocusRequest).toBe(0)
    await act(() => transition())
    const second = conversation().props.composerFocusRequest
    expect(second).toBeGreaterThan(first)
    await act(() => conversation().props.onComposerFocusHandled(first))
    expect(conversation().props.composerFocusRequest).toBe(second)
  })

  it('expires requests on blur and cancelled transitions instead of focusing another page', async () => {
    await act(() => list().props.onNewConversation())
    await act(() => listeners().blur())
    await act(() => transition())
    expect(conversation().props.composerFocusRequest).toBe(0)
    await act(() => list().props.onNewConversation())
    await act(() => listeners().transitionStart({ data: { closing: true } }))
    await act(() => transition(true))
    await act(() => transition())
    expect(conversation().props.composerFocusRequest).toBe(0)
    await act(() => list().props.onNewConversation())
    navigation.currentRouteKey = 'settings'
    await act(() => transition())
    expect(conversation().props.composerFocusRequest).toBe(0)
  })

  it('focuses an explicit new conversation on the active page without waiting for a navigation event', async () => {
    await act(() => conversation().props.onNewConversation())
    const request = conversation().props.composerFocusRequest
    expect(request).toBeGreaterThan(0)
    await act(() => conversation().props.onComposerFocusHandled(request))
    await act(() => transition())
    expect(conversation().props.composerFocusRequest).toBe(0)
  })
})
