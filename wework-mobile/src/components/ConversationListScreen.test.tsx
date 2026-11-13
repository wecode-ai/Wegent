import React from 'react'
import { View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationItem, DeviceInfo, RuntimeDeviceWorkspace } from '@/types/runtime'
import { ConversationListScreen } from './ConversationListScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const environment = vi.hoisted(() => ({ platform: 'ios', backHandlers: new Set<() => boolean>() }))

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
vi.mock('./KeyboardSafeInput', () => ({
  KeyboardSafeView: 'KeyboardSafeView',
  KeyboardSafeTextInput: 'KeyboardSafeTextInput',
  useKeyboardVisible: () => false,
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
    environment.platform = 'ios'
  })

  async function render(
    devices: DeviceInfo[],
    workspaces: Array<{ projectName: string; workspace: RuntimeDeviceWorkspace }> = [],
    conversations: ConversationItem[] = []
  ) {
    const onNewConversation = vi.fn()
    const onSearch = vi.fn()
    const onSettings = vi.fn()
    await act(() => {
      renderer = create(
        <ConversationListScreen
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
          onRefresh={vi.fn()}
          onSelectDevice={vi.fn()}
          onSelectAllDevices={vi.fn()}
          onSelectConversation={vi.fn()}
          onNewConversation={onNewConversation}
          onNewProject={vi.fn()}
          onSettings={onSettings}
        />
      )
    })
    const pressable = (testID: string) =>
      renderer.root.findAll(
        node => node.type === ('Pressable' as React.ElementType) && node.props.testID === testID
      )[0]!
    return { onNewConversation, onSearch, onSettings, pressable }
  }

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

  it('allows new chat inside an existing computer workspace while keeping project creation disabled', async () => {
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
    expect(pressable('drawer-new-project').props.disabled).toBe(true)
  })

  it('moves search into the header and restores the new-chat dock when dismissed', async () => {
    const { onSearch, pressable } = await render([computer])
    expect(renderer.root.findAllByProps({ testID: 'conversation-search' })).toHaveLength(0)
    await act(() => pressable('drawer-search-toggle').props.onPress())
    const search = renderer.root.findByType('KeyboardSafeTextInput' as never)
    expect(search.props.autoFocus).toBe(true)
    expect(renderer.root.findAllByProps({ testID: 'drawer-new-conversation' })).toHaveLength(0)
    await act(() => search.props.onChangeText('project'))
    expect(onSearch).toHaveBeenLastCalledWith('project')
    await act(() => pressable('drawer-search-toggle').props.onPress())
    expect(onSearch).toHaveBeenLastCalledWith('')
    expect(pressable('drawer-new-conversation')).toBeDefined()
  })

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
})
