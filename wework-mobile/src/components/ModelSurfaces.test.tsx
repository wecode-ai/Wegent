import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UnifiedModel } from '@/types/runtime'
import { ModelPickerScreen } from './ModelPickerDialog'
import { QuickModelSelector } from './QuickModelSelector'
import { ModelOptionPopover } from './ModelOptionPopover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const backHandlers = vi.hoisted(() => new Set<() => boolean>())

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (styles: object | object[]) =>
      Array.isArray(styles) ? Object.assign({}, ...styles) : styles,
    absoluteFill: { position: 'absolute', inset: 0 },
    hairlineWidth: 0.5,
  },
  Platform: { OS: 'android' },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backHandlers.add(handler)
      return { remove: () => backHandlers.delete(handler) }
    },
  },
  AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
  findNodeHandle: () => 1,
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  useTheme: () => ({
    dark: false,
    colors: { onSurface: '#111', onSurfaceVariant: '#777', surface: '#fff' },
  }),
}))
vi.mock('./LiquidGlass', () => ({ LiquidGlassSurface: 'LiquidGlassSurface' }))

const model: UnifiedModel = {
  name: 'device-model',
  type: 'runtime',
  provider: 'local',
  config: {
    weworkModelKind: 'codex-official',
    ui: { reasoningEfforts: ['low', 'high'], controls: ['speed'] },
  },
}

describe('model control surfaces', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    backHandlers.clear()
  })

  const control = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!

  async function picker(overrides: Partial<React.ComponentProps<typeof ModelPickerScreen>> = {}) {
    const props: React.ComponentProps<typeof ModelPickerScreen> = {
      models: [model],
      selectedModel: model,
      selectedOptions: { reasoning: 'low', speed: 'fast' },
      loading: false,
      error: null,
      onLoadModels: vi.fn().mockResolvedValue(undefined),
      onDismiss: vi.fn(),
      onSelect: vi.fn(),
      ...overrides,
    }
    await act(() => {
      renderer = create(<ModelPickerScreen {...props} />, {
        createNodeMock: () => ({
          measureLayout: (_root: unknown, done: (...rect: number[]) => void) =>
            done(24, 480, 342, 50),
        }),
      })
    })
    return props
  }

  it('keeps model loading, failure and refresh recovery available in the sheet', async () => {
    const props = await picker({ loading: true, error: 'Device unavailable' })
    expect(props.onLoadModels).toHaveBeenCalledOnce()
    expect(control('device-models-loading')).toBeDefined()
    expect(control('device-models-error').props.children).toBe('Device unavailable')
    expect(control('advanced-model-row').props.disabled).toBeUndefined()
    await act(() => control('advanced-model-row').props.onPress())
    expect(control('refresh-device-models').props.disabled).toBe(true)

    await act(() => renderer.update(<ModelPickerScreen {...props} loading={false} />))
    await act(() => control('refresh-device-models').props.onPress())
    expect(props.onLoadModels).toHaveBeenLastCalledWith(true)
  })

  it('selects the actual catalog model and closes its menu', async () => {
    const props = await picker()
    await act(() => control('advanced-model-row').props.onPress())
    const option = control('model-option-runtime-device-model')
    expect(option.props.accessibilityState.selected).toBe(true)
    await act(() => option.props.onPress())
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(model)
    expect(
      renderer.root.findAll(node => node.props.testID === 'model-option-runtime-device-model')
    ).toHaveLength(0)
  })

  it('preserves other selected options when changing reasoning or speed', async () => {
    const props = await picker()
    await act(() => control('advanced-reasoning-row').props.onPress())
    await act(() => control('reasoning-option-high').props.onPress())
    expect(props.onSelect).toHaveBeenLastCalledWith(model, { reasoning: 'high', speed: 'fast' })
    await act(() => control('advanced-speed-row').props.onPress())
    await act(() => control('speed-option-standard').props.onPress())
    expect(props.onSelect).toHaveBeenLastCalledWith(model, { reasoning: 'low', speed: 'standard' })
  })

  it('does not present unsupported model capabilities as enabled', async () => {
    await picker({
      selectedModel: {
        ...model,
        config: { weworkModelKind: 'model-interface', ui: { reasoningEfforts: [], controls: [] } },
      },
    })
    expect(control('advanced-reasoning-row').props.accessibilityState.disabled).toBe(true)
    expect(control('advanced-speed-row').props.accessibilityState.disabled).toBe(true)
  })

  it('adjusts only supported reasoning levels and bounds accessible increments', async () => {
    const onSelectEffort = vi.fn()
    await act(() => {
      renderer = create(
        <QuickModelSelector
          label="Device model"
          sourceLabel="设备模型"
          effort="high"
          efforts={['low', 'high']}
          onSelectEffort={onSelectEffort}
          onOpenAdvanced={vi.fn()}
        />
      )
    })
    const slider = control('quick-reasoning-slider')
    expect(slider.props.accessible).toBe(true)
    expect(slider.props.accessibilityRole).toBe('adjustable')
    expect(slider.props.accessibilityValue).toEqual({ min: 1, max: 2, now: 2, text: '高' })
    await act(() =>
      slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
    )
    expect(onSelectEffort).not.toHaveBeenCalled()
    await act(() =>
      slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } })
    )
    expect(onSelectEffort).toHaveBeenCalledExactlyOnceWith('low')
  })

  it('keeps the advanced recovery entry when the model has no reasoning levels', async () => {
    const onOpenAdvanced = vi.fn()
    await act(() => {
      renderer = create(
        <QuickModelSelector
          label="选择模型"
          sourceLabel="设备模型"
          effort={undefined}
          efforts={[]}
          onSelectEffort={vi.fn()}
          onOpenAdvanced={onOpenAdvanced}
        />
      )
    })
    expect(control('quick-reasoning-unavailable')).toBeDefined()
    await act(() => control('quick-model-advanced').props.onPress())
    expect(onOpenAdvanced).toHaveBeenCalledOnce()
  })

  it('selects reasoning by tap and drag in a stable coordinate space and retains the controlled value', async () => {
    const onSelectEffort = vi.fn()
    function Harness() {
      const [effort, setEffort] = React.useState('low')
      return (
        <QuickModelSelector
          label="Model"
          sourceLabel="设备模型"
          effort={effort}
          efforts={['low', 'medium', 'high', 'xhigh']}
          onOpenAdvanced={vi.fn()}
          onSelectEffort={next => {
            onSelectEffort(next)
            setEffort(next)
          }}
        />
      )
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() =>
      control('quick-reasoning-slider').props.onLayout({ nativeEvent: { layout: { width: 320 } } })
    )
    expect(control('quick-reasoning-slider').props.pointerEvents).toBe('box-only')
    await act(() =>
      control('quick-reasoning-slider').props.onResponderGrant({
        nativeEvent: { pageX: 136, locationX: 36 },
      })
    )
    await act(() =>
      control('quick-reasoning-slider').props.onResponderMove({
        nativeEvent: { pageX: 384, locationX: 4 },
      })
    )
    expect(onSelectEffort).toHaveBeenLastCalledWith('xhigh')
    expect(control('quick-reasoning-slider').props.accessibilityValue.now).toBe(4)
    await act(() => control('quick-reasoning-slider').props.onResponderRelease())
    expect(control('quick-reasoning-slider').props.accessibilityValue.now).toBe(4)
    await act(() =>
      control('quick-reasoning-slider').props.onResponderGrant({
        nativeEvent: { pageX: 260, locationX: 160 },
      })
    )
    expect(onSelectEffort).toHaveBeenLastCalledWith('high')
    await act(() =>
      control('quick-reasoning-slider').props.onResponderMove({
        nativeEvent: { pageX: -50, locationX: 0 },
      })
    )
    expect(onSelectEffort).toHaveBeenLastCalledWith('low')
  })

  it('uses measured content height inside one bounded glass popover and consumes Android back', async () => {
    const onDismiss = vi.fn()
    await act(() => {
      renderer = create(
        <ModelOptionPopover
          anchor={{ x: 24, y: 480, width: 342, height: 50 }}
          kind="reasoning"
          onDismiss={onDismiss}
          viewport={{ width: 390, height: 844, topInset: 59, bottomInset: 34 }}
        >
          <TextFixture />
        </ModelOptionPopover>
      )
    })
    expect(renderer.root.findAllByType('LiquidGlassSurface' as never)).toHaveLength(0)
    const measuringFrame = Object.assign({}, ...control('reasoning-menu-popover').props.style)
    expect(measuringFrame.opacity).toBeUndefined()
    expect(control('reasoning-menu-scroll').props.accessibilityElementsHidden).toBe(true)
    await act(() => control('reasoning-menu-scroll').props.onContentSizeChange(264, 280))
    const frame = Object.assign({}, ...control('reasoning-menu-popover').props.style)
    expect(frame).toMatchObject({ left: 102, top: 250, height: 280, width: 264 })
    expect(frame.opacity).toBeUndefined()
    expect(control('reasoning-menu-popover').props.accessibilityViewIsModal).toBe(true)
    const glass = renderer.root.findByType('LiquidGlassSurface' as never)
    expect(glass.props.children).toBeNull()
    let ancestor = glass.parent
    while (ancestor) {
      const style = Array.isArray(ancestor.props.style)
        ? Object.assign({}, ...ancestor.props.style)
        : ancestor.props.style
      expect(style?.opacity == null || style.opacity === 1).toBe(true)
      ancestor = ancestor.parent
    }
    expect(renderer.root.findByType('TextFixture' as never)).toBeDefined()
    expect([...backHandlers][0]!()).toBe(true)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('shows an empty-catalog explanation and a working refresh in the model popover', async () => {
    const props = await picker({ models: [], selectedModel: null })
    await act(() => control('advanced-model-row').props.onPress())
    expect(control('model-menu-empty').props.children).toBe('暂无可用模型')
    await act(() => control('refresh-device-models').props.onPress())
    expect(props.onLoadModels).toHaveBeenLastCalledWith(true)
  })
})

function TextFixture() {
  return React.createElement('TextFixture')
}
