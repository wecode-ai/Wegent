import React from 'react'
import { createRequire } from 'node:module'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkbenchSidebar } from './WorkbenchSidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  Image: 'Image',
  Modal: 'Modal',
  Pressable: 'Pressable',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('react-native-paper', () => ({ Text: 'Text', useTheme: () => ({ colors: {} }) }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}))
vi.mock('./LiquidGlass', () => ({ LiquidGlassButton: 'LiquidGlassButton' }))
const require = createRequire(import.meta.url)
const assetPath = require.resolve('../../assets/wework-logo-transparent.png')
const originalAsset = require.cache[assetPath]
beforeAll(() => {
  require.cache[assetPath] = { exports: 1 } as NodeJS.Module
})
afterAll(() => {
  if (originalAsset) require.cache[assetPath] = originalAsset
  else delete require.cache[assetPath]
})

describe('sidebar connection retry', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  const avatar = () => renderer.root.findByProps({ testID: 'workbench-sidebar-avatar' })
  it('shows failures only as an avatar badge, retries once per tap, and retains access to settings', async () => {
    const props = {
      visible: true,
      userLabel: 'User',
      onDismiss: vi.fn(),
      onSettings: vi.fn(),
      onRetryConnection: vi.fn(async () => {}),
      connectionError: 'private HTTP exception',
      reconnecting: false,
    }
    await act(() => {
      renderer = create(<WorkbenchSidebar {...props} />)
    })
    expect(
      renderer.root.findAllByProps({ testID: 'workbench-sidebar-connection-badge' })
    ).toHaveLength(1)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('private HTTP exception')
    expect(props.onRetryConnection).not.toHaveBeenCalled()
    await act(() => avatar().props.onPress())
    expect(props.onRetryConnection).toHaveBeenCalledOnce()
    expect(props.onDismiss).not.toHaveBeenCalled()
    expect(props.onSettings).not.toHaveBeenCalled()
    await act(() => renderer.update(<WorkbenchSidebar {...props} reconnecting />))
    expect(avatar().props.disabled).toBe(true)
    expect(avatar().props.accessibilityState.busy).toBe(true)
    expect(renderer.root.findAllByType('ActivityIndicator' as never)).toHaveLength(1)
    await act(() =>
      renderer.root.findByProps({ testID: 'workbench-sidebar-settings' }).props.onPress()
    )
    expect(props.onSettings).toHaveBeenCalledOnce()
    await act(() => renderer.update(<WorkbenchSidebar {...props} connectionError={null} />))
    expect(
      renderer.root.findAllByProps({ testID: 'workbench-sidebar-connection-badge' })
    ).toHaveLength(0)
    await act(() => avatar().props.onPress())
    expect(props.onSettings).toHaveBeenCalledTimes(2)
    expect(props.onRetryConnection).toHaveBeenCalledOnce()
  })
})
