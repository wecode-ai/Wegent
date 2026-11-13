import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeviceInfo, RuntimeDeviceWorkspace } from '@/types/runtime'
import { ConversationListScreen } from './ConversationListScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  FlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
  }: {
    data: unknown[]
    renderItem: (value: { item: unknown }) => React.ReactNode
    ListHeaderComponent?: React.ReactNode
  }) => (
    <>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <React.Fragment key={index}>{renderItem({ item })}</React.Fragment>
      ))}
    </>
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
  })

  async function render(
    devices: DeviceInfo[],
    workspaces: Array<{ projectName: string; workspace: RuntimeDeviceWorkspace }> = []
  ) {
    const onNewConversation = vi.fn()
    await act(() => {
      renderer = create(
        <ConversationListScreen
          devices={devices}
          conversations={[]}
          workspaces={workspaces}
          currentAddress={null}
          selectedDeviceId="app-record-11"
          allDevicesSelected={false}
          search=""
          loading={false}
          refreshing={false}
          onSearch={vi.fn()}
          onRefresh={vi.fn()}
          onSelectDevice={vi.fn()}
          onSelectAllDevices={vi.fn()}
          onSelectConversation={vi.fn()}
          onNewConversation={onNewConversation}
          onNewProject={vi.fn()}
          onSettings={vi.fn()}
          onOpenCurrentConversation={vi.fn()}
        />
      )
    })
    const pressable = (testID: string) =>
      renderer.root.findAll(
        node => node.type === ('Pressable' as React.ElementType) && node.props.testID === testID
      )[0]!
    return { onNewConversation, pressable }
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
})
