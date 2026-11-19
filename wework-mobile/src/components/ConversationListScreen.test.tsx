vi.mock('./ConversationMenu', () => ({
  ConversationMenu: (props: {
    renderRow?: (input: object) => React.ReactNode
    onArchive: () => void
  }) =>
    React.createElement(
      'ConversationMenu',
      props,
      props.renderRow?.({ disabled: false, onArchive: props.onArchive, onLongPress: vi.fn() })
    ),
}))
vi.mock('./SwipeArchiveRow', () => ({
  SwipeArchiveRow: (props: {
    children: (onPress: () => void) => React.ReactNode
    onPress: () => void
  }) => React.createElement('SwipeRow', props, props.children(props.onPress)),
}))
vi.mock('./ProjectMenu', () => ({ ProjectMenu: 'ProjectMenu' }))
import React from 'react'
import { FlatList, Keyboard, StyleSheet, View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationItem, DeviceInfo, RuntimeDeviceWorkspace } from '@/types/runtime'
import { ConversationListScreen } from './ConversationListScreen'
import { setDiagnosticRecording } from '@/services/mobileDiagnostics'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const environment = vi.hoisted(() => ({
  platform: 'ios',
  backHandlers: new Set<() => boolean>(),
  keyboardVisible: false,
  safeAreaBottom: 34,
}))

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: environment.safeAreaBottom, left: 0, right: 0 }),
}))
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return environment.platform
    },
  },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      environment.backHandlers.add(handler)
      return { remove: () => environment.backHandlers.delete(handler) }
    },
  },
  Keyboard: { dismiss: vi.fn() },
  StyleSheet: {
    create: (styles: unknown) => styles,
    absoluteFillObject: {},
    flatten: (style: unknown) =>
      Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style,
  },
  processColor: () => null,
  View: 'View',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  FlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    testID,
  }: {
    data: unknown[]
    renderItem: (value: { item: unknown }) => React.ReactNode
    ListHeaderComponent?: React.ReactNode
    ListEmptyComponent?: React.ReactNode
    testID?: string
  }) => (
    <View testID={testID}>
      {ListHeaderComponent}
      {!data.length ? ListEmptyComponent : null}
      {data.map((item, index) => (
        <React.Fragment key={index}>{renderItem({ item })}</React.Fragment>
      ))}
    </View>
  ),
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Portal: 'Portal',
  Text: 'Text',
  useTheme: () => ({
    dark: false,
    colors: { primary: 'blue', onSurfaceVariant: 'gray', elevation: { level2: 'white' } },
  }),
}))
vi.mock('./WorkbenchSidebar', () => ({ WorkbenchSidebar: 'WorkbenchSidebar' }))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  useKeyboardState: (selector: (state: { isVisible: boolean }) => unknown) =>
    selector({ isVisible: environment.keyboardVisible }),
}))

const computer: DeviceInfo = {
  id: 11,
  device_id: 'app-record-11',
  execution_target_id: 'app-record-11',
  name: 'My only computer',
  device_type: 'app',
  bind_shell: 'claudecode',
  status: 'online',
  runtime_features: {
    schemaVersion: 4,
    remoteTaskAccess: { version: 1, enabled: true, taskCreation: true },
  },
}

describe('new conversation controls', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    setDiagnosticRecording(false)
    environment.platform = 'ios'
    environment.keyboardVisible = false
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  async function render(
    devices: DeviceInfo[],
    workspaces: Array<{ projectName: string; workspace: RuntimeDeviceWorkspace }> = [],
    conversations: ConversationItem[] = [],
    overrides: Partial<React.ComponentProps<typeof ConversationListScreen>> = {}
  ) {
    const onNewConversation = vi.fn()
    const onSearch = vi.fn()
    const onSettings = vi.fn()
    const onSelectDevice = vi.fn()
    const onRefresh = vi.fn(async () => {})
    const onRefreshDevices = vi.fn(async () => {})
    const element = (
      <ConversationListScreen
        failures={[]}
        onRetryFailure={vi.fn()}
        devices={devices}
        conversations={conversations}
        workspaces={workspaces}
        currentAddress={null}
        selectedDeviceId="app-record-11"
        allDevicesSelected={false}
        search=""
        loading={false}
        refreshing={false}
        onSearch={onSearch}
        onRefresh={onRefresh}
        onRefreshDevices={onRefreshDevices}
        onSelectDevice={onSelectDevice}
        onSelectAllDevices={vi.fn()}
        onSelectConversation={vi.fn()}
        onNewConversation={onNewConversation}
        onNewProject={vi.fn()}
        onSettings={onSettings}
        {...overrides}
      />
    )
    await act(() => {
      renderer = create(element)
    })
    const rerender = (patch: Partial<React.ComponentProps<typeof ConversationListScreen>> = {}) =>
      act(() => renderer.update(React.cloneElement(element, patch)))
    const pressable = (testID: string) =>
      renderer.root.findAll(
        node => node.type === ('Pressable' as React.ElementType) && node.props.testID === testID
      )[0]!
    return {
      onNewConversation,
      onSearch,
      onSettings,
      onSelectDevice,
      onRefresh,
      onRefreshDevices,
      pressable,
      rerender,
    }
  }

  it('finishes list diagnostics only after a real snapshot is committed without loading', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    setDiagnosticRecording(true)
    const { rerender } = await render([computer])
    const completed = () =>
      output.mock.calls.filter(
        ([event, details]) =>
          event === '[MobileLifecycle]' &&
          details.operation === 'conversation-list' &&
          details.phase === 'complete'
      )
    expect(completed()).toHaveLength(0)
    await rerender({ loading: true, snapshotReady: true })
    expect(completed()).toHaveLength(0)
    await rerender({ loading: false, snapshotReady: true })
    expect(completed()).toHaveLength(1)
    expect(completed()[0]?.[1]).toMatchObject({ conversations: 0, snapshotReady: 1, loading: 0 })
  })

  it('does not attach list layout diagnostics while recording is disabled', async () => {
    setDiagnosticRecording(false)
    await render([computer])
    expect(renderer.root.findAllByType(FlatList).every(list => !list.props.onLayout)).toBe(true)
  })

  it('refreshes the device inventory independently without refreshing conversations', async () => {
    const { pressable, onRefresh, onRefreshDevices } = await render([computer])
    let finish!: () => void
    onRefreshDevices.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    await act(() => pressable('drawer-actions').props.onPress())
    await act(() => {
      pressable('drawer-refresh-devices').props.onPress()
      pressable('drawer-refresh-devices').props.onPress()
    })
    expect(onRefreshDevices).toHaveBeenCalledOnce()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(pressable('drawer-refresh-devices').props.disabled).toBe(true)
    expect(pressable('drawer-settings').props.disabled).toBe(false)
    await act(() => finish())
    expect(pressable('drawer-refresh-devices').props.disabled).toBe(false)
  })

  it('opens a new conversation with only the opted-in computer present', async () => {
    const { onNewConversation, pressable } = await render([computer])
    const button = pressable('drawer-new-conversation')
    expect(button.props.disabled).toBe(false)
    expect(button.props.accessibilityState.disabled).toBe(false)
    await act(() => button.props.onPress())
    expect(onNewConversation).toHaveBeenCalledOnce()
  })

  it.each([
    { ...computer, status: 'offline' as const },
    {
      ...computer,
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1 as const, enabled: false, taskCreation: true },
      },
    },
    {
      ...computer,
      runtime_features: {
        schemaVersion: 4,
        remoteTaskAccess: { version: 1 as const, enabled: true },
      },
    },
  ])('disables and dims new chat when unavailable: %j', async device => {
    const { pressable } = await render([device])
    const button = pressable('drawer-new-conversation')
    expect(button.props.disabled).toBe(true)
    const icon = button.findByType('Icon' as never)
    expect(icon.props.color).toBe('gray')
  })

  it('allows both project creation and new chat on the opted-in computer', async () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'app-record-11',
      deviceName: 'My only computer',
      deviceStatus: 'online',
      workspacePath: '/repo',
      available: true,
      tasks: [],
    }
    const { onNewConversation, pressable } = await render(
      [computer],
      [{ projectName: 'Project', workspace }]
    )
    const button = pressable('workspace-new-app-record-11-/repo')
    expect(button.props.disabled).toBe(false)
    await act(() => button.props.onPress())
    expect(onNewConversation).toHaveBeenCalledWith(workspace)
    await act(() => pressable('drawer-actions').props.onPress())
    expect(pressable('drawer-new-project').props.disabled).toBe(false)
  })

  it('moves search into the header and restores the new-chat dock when dismissed', async () => {
    const { onSearch, pressable } = await render([computer])
    expect(renderer.root.findAllByProps({ testID: 'conversation-search' })).toHaveLength(0)
    await act(() => pressable('drawer-search-toggle').props.onPress())
    const search = renderer.root.findByType('TextInput' as never)
    expect(search.props.autoFocus).toBe(true)
    expect(renderer.root.findAllByProps({ testID: 'drawer-new-conversation' })).toHaveLength(0)
    await act(() => search.props.onChangeText('project'))
    expect(onSearch).toHaveBeenLastCalledWith('project')
    await act(() => pressable('drawer-search-toggle').props.onPress())
    expect(onSearch).toHaveBeenLastCalledWith('')
    expect(pressable('drawer-new-conversation')).toBeDefined()
    expect(Keyboard.dismiss).toHaveBeenCalledOnce()
  })

  it('allows device filtering through its horizontal list while the search keyboard is open', async () => {
    environment.keyboardVisible = true
    const otherDevice = { ...computer, id: 12, device_id: 'app-record-12' }
    const { onSelectDevice, pressable } = await render([computer, otherDevice])
    await act(() => pressable('drawer-search-toggle').props.onPress())
    const deviceStrip = renderer.root
      .findAllByType(FlatList)
      .find(node => node.props.testID === 'device-carousel')!
    expect(deviceStrip.props.horizontal).toBe(true)
    expect(deviceStrip.props.keyboardShouldPersistTaps).toBe('handled')
    await act(() => pressable('device-option-app-record-12').props.onPress())
    expect(onSelectDevice).toHaveBeenCalledExactlyOnceWith('app-record-12')
    expect(Keyboard.dismiss).not.toHaveBeenCalled()
    expect(renderer.root.findByType('TextInput' as never).props.testID).toBe('conversation-search')
  })

  it.each(['ios', 'android'])(
    'keeps search and its results inside one keyboard-resized viewport on %s',
    async platform => {
      environment.platform = platform
      environment.keyboardVisible = true
      const { pressable, rerender } = await render([computer])
      await act(() => pressable('drawer-search-toggle').props.onPress())

      const viewport = renderer.root.findByType('KeyboardAvoidingView' as never)
      expect(viewport.props.behavior).toBe('height')
      expect(viewport.props.automaticOffset).toBe(true)
      expect(viewport.props.enabled).toBe(true)
      expect(viewport.findByType('TextInput' as never).props.testID).toBe('conversation-search')
      expect(viewport.findAllByProps({ testID: 'conversation-list' }).length).toBeGreaterThan(0)
      const results = viewport
        .findAllByType(FlatList)
        .find(node => node.props.testID === 'conversation-list')!
      expect(results.props.keyboardDismissMode).toBe(platform === 'ios' ? 'interactive' : 'on-drag')
      expect(results.props.keyboardShouldPersistTaps).toBe('handled')
      expect(renderer.root.findAllByType('KeyboardAvoidingView' as never)).toHaveLength(1)

      await act(() => pressable('drawer-search-toggle').props.onPress())
      const dockBottom = () =>
        StyleSheet.flatten(
          renderer.root.find(
            node =>
              node.type === ('View' as never) &&
              StyleSheet.flatten(node.props.style)?.bottom !== undefined
          ).props.style
        ).bottom
      expect(dockBottom()).toBe(8)
      environment.keyboardVisible = false
      await rerender()
      expect(dockBottom()).toBe(environment.safeAreaBottom)
    }
  )

  it('opens the Wework sidebar even before a conversation is selected', async () => {
    const { onSettings, pressable } = await render([computer])
    await act(() => pressable('drawer-close').props.onPress())
    let sidebar = renderer.root.findByType('WorkbenchSidebar' as never)
    expect(sidebar.props.visible).toBe(true)
    await act(() => {
      sidebar.props.onDismiss()
      sidebar.props.onSettings()
    })
    sidebar = renderer.root.findByType('WorkbenchSidebar' as never)
    expect(sidebar.props.visible).toBe(false)
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it('shows real pinned conversations only after expanding the pinned section', async () => {
    const pinned: ConversationItem = {
      address: { deviceId: computer.device_id, taskId: 'pinned-task' },
      sourceWorkspacePath: '/chat',
      title: 'Pinned',
      deviceName: computer.name,
      projectName: null,
      updatedAt: 10,
      running: false,
      pinned: true,
    }
    const { pressable } = await render([computer], [], [pinned])
    expect(renderer.root.findAllByProps({ testID: 'conversation-pinned-task' })).toHaveLength(0)
    await act(() => pressable('section-pinned-toggle').props.onPress())
    expect(pressable('conversation-pinned-task')).toBeDefined()
    expect(renderer.root.findAllByProps({ testID: 'conversation-pinned-task' })).toHaveLength(1)
  })

  it('closes transient home controls before Android handles system back', async () => {
    environment.platform = 'android'
    const { onSearch, pressable } = await render([computer])
    await act(() => pressable('drawer-search-toggle').props.onPress())
    let handler = [...environment.backHandlers][0]!
    await act(() => {
      expect(handler()).toBe(true)
    })
    expect(onSearch).toHaveBeenLastCalledWith('')
    expect(environment.backHandlers.size).toBe(0)
    await act(() => pressable('drawer-actions').props.onPress())
    handler = [...environment.backHandlers][0]!
    await act(() => {
      expect(handler()).toBe(true)
    })
    expect(renderer.root.findAllByProps({ testID: 'drawer-actions-menu' })).toHaveLength(0)
    expect(environment.backHandlers.size).toBe(0)
  })

  it('scrolls the device strip with the conversation list instead of pinning it above the list', async () => {
    await render([computer])
    const list = renderer.root.findAll(
      node => node.type === ('View' as never) && node.props.testID === 'conversation-list'
    )[0]!
    expect(
      list.findAll(
        node => node.type === ('View' as never) && node.props.testID === 'device-carousel'
      )
    ).toHaveLength(1)
  })
  it('allows one revealed archive row and closes it on native scrolling or a scope change', async () => {
    const conversations: ConversationItem[] = ['first', 'second'].map(taskId => ({
      address: { deviceId: computer.device_id, taskId },
      sourceWorkspacePath: '/repo',
      title: taskId,
      deviceName: computer.name,
      projectName: null,
      updatedAt: 1,
      running: false,
    }))
    const actions = {
      threadId: 'thread',
      canPin: true,
      pinned: false,
      onPin: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onSettings: vi.fn(),
    }
    const state = await render([computer], [], conversations, {
      conversationActions: () => actions,
    })
    const rows = () => renderer.root.findAllByType('SwipeRow' as never)
    expect(rows()).toHaveLength(2)
    await act(() => rows()[0]!.props.onOpen())
    expect(rows().map(row => row.props.open)).toEqual([true, false])
    await act(() => {
      rows()[1]!.props.onSwipeStart()
      rows()[1]!.props.onOpen()
    })
    expect(rows().map(row => row.props.open)).toEqual([false, true])
    await act(() => renderer.root.findByType(FlatList).props.onScrollBeginDrag())
    expect(rows().every(row => !row.props.open)).toBe(true)
    await act(() => rows()[0]!.props.onOpen())
    await state.rerender({ search: 'first' })
    expect(rows().every(row => !row.props.open)).toBe(true)
    expect(renderer.root.findAllByProps({ name: 'ellipsis-horizontal' })).toHaveLength(0)
  })
})
