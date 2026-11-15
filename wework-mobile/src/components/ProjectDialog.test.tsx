import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeviceInfo } from '@/types/runtime'
import { ProjectDialog } from './ProjectDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  TextInput: 'TextInput',
  View: 'View',
}))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAwareScrollView: 'KeyboardAwareScrollView',
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34 }),
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Portal: 'Portal',
  Text: 'Text',
  useTheme: () => ({
    dark: false,
    colors: { elevation: { level3: '#fff' }, onSurface: '#111', error: '#b00' },
  }),
}))
vi.mock('./LiquidGlass', () => ({
  LiquidGlassButton: 'LiquidGlassButton',
  LiquidGlassSurface: 'LiquidGlassSurface',
  liquidGlassAccentBorder: '#999',
  liquidGlassAccentTint: '#555',
}))

describe('project form keyboard layout', () => {
  let renderer: ReactTestRenderer | undefined
  const device: DeviceInfo = {
    id: 1,
    device_id: 'remote-device',
    name: 'Remote executor',
    status: 'online',
    device_type: 'remote',
    bind_shell: 'claudecode',
  }
  const find = (testID: string) => renderer!.root.findByProps({ testID })

  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = undefined
  })

  async function render(onCreate = vi.fn().mockResolvedValue(undefined)) {
    const props = {
      visible: true,
      devices: [device],
      selectedDeviceId: device.device_id,
      onCreate,
      onDismiss: vi.fn(),
    }
    await act(() => {
      renderer = create(<ProjectDialog {...props} />)
    })
    return props
  }

  it('scrolls the whole form including actions with a single keyboard owner', async () => {
    await render()
    const scroll = find('project-form-scroll')
    expect(scroll.type).toBe('KeyboardAwareScrollView')
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled')
    expect(scroll.props.bottomOffset).toBeGreaterThan(0)
    for (const testID of ['project-name', 'project-workspace-path', 'project-create-submit']) {
      expect(scroll.findByProps({ testID })).toBeDefined()
    }
    const nestedScrolls = scroll.findAllByType('ScrollView' as never)
    expect(nestedScrolls).toHaveLength(1)
    expect(nestedScrolls[0]!.props.horizontal).toBe(true)
    expect(nestedScrolls[0]!.props.keyboardShouldPersistTaps).toBe('handled')
  })

  it('submits the selected remote device and edited fields through the scrollable actions', async () => {
    const props = await render()
    await act(() => find('project-name').props.onChangeText('Remote project'))
    await act(() => find('project-workspace-path').props.onChangeText('/workspace/project'))
    await act(() => find('project-create-submit').props.onPress())
    expect(props.onCreate).toHaveBeenCalledWith({
      deviceId: device.device_id,
      name: 'Remote project',
      workspacePath: '/workspace/project',
    })
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })

  it('retains entered fields and allows retry after creation fails', async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Device offline'))
      .mockResolvedValue(undefined)
    const props = await render(onCreate)
    await act(() => find('project-name').props.onChangeText('Retained name'))
    await act(() => find('project-workspace-path').props.onChangeText('/workspace/retry'))
    await act(() => find('project-create-submit').props.onPress())
    expect(find('project-name').props.value).toBe('Retained name')
    expect(find('project-workspace-path').props.value).toBe('/workspace/retry')
    expect(props.onDismiss).not.toHaveBeenCalled()
    expect(find('project-create-submit').props.disabled).toBe(false)
    await act(() => find('project-create-submit').props.onPress())
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })
})
