import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QuickModelSelector } from './QuickModelSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }))
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn(async () => undefined) }))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFill: { position: 'absolute', inset: 0 },
    create: (styles: unknown) => styles,
  },
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({
    dark: false,
    colors: { onSurface: '#111111', onSurfaceVariant: '#777777' },
  }),
}))
vi.mock('react-native-reanimated', () => {
  const Animated = { View: 'AnimatedView' }
  return {
    __esModule: true,
    default: Animated,
    FadeIn: { duration: () => ({}) },
    FadeInDown: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    SlideInDown: {
      springify: () => ({
        damping: () => ({ stiffness: () => ({ mass: () => ({}) }) }),
      }),
    },
    SlideOutDown: { duration: () => ({}) },
    interpolate: (_value: number, _input: number[], output: number[]) => output[0],
    interpolateColor: (_value: number, _input: number[], output: string[]) => output[0],
    useAnimatedStyle: (factory: () => object) => factory(),
    useDerivedValue: (factory: () => number) => ({ value: factory() }),
    useSharedValue: (value: number) => ({ value }),
    withSpring: (value: number) => value,
  }
})
vi.mock('./ModelControlSurface', () => ({ ModelControlSurface: 'ModelControlSurface' }))

describe('QuickModelSelector', () => {
  let renderer: ReactTestRenderer

  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })

  const element = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!

  async function render(overrides: Partial<React.ComponentProps<typeof QuickModelSelector>> = {}) {
    const props = {
      effort: 'medium',
      efforts: ['low', 'medium', 'high'],
      label: 'GPT-6.1-Sol',
      onOpenAdvanced: vi.fn(),
      onSelectEffort: vi.fn(),
      sourceLabel: '设备模型',
      ...overrides,
    }
    await act(() => {
      renderer = create(<QuickModelSelector {...props} />)
    })
    return props
  }

  it('renders one visual step per model level', async () => {
    const props = await render()
    const dots = () =>
      renderer.root.findAll(
        node =>
          typeof node.props.testID === 'string' && node.props.testID.startsWith('quick-visual-dot-')
      )

    expect(dots()).toHaveLength(3)

    await act(() =>
      renderer.update(
        <QuickModelSelector
          {...props}
          effort="high"
          efforts={['low', 'medium', 'high', 'xhigh', 'max']}
        />
      )
    )
    expect(dots()).toHaveLength(5)
  })

  it('shows the full model name with the selected reasoning level', async () => {
    await render({ effort: 'high', label: '公网:DeepSeek-V4.1-Flash' })

    expect(element('quick-model-name').props.children).toBe('公网:DeepSeek-V4.1-Flash')
    expect(element('quick-model-effort').props.children).toBe('高')
  })

  it('shows the current reasoning level and selects a new level by dragging', async () => {
    const props = await render()
    expect(element('quick-model-advanced').props.accessibilityLabel).toContain('中')
    await act(() =>
      element('quick-reasoning-slider').props.onLayout({
        nativeEvent: { layout: { width: 300 } },
      })
    )
    await act(() =>
      element('quick-reasoning-slider').props.onResponderGrant({
        nativeEvent: { locationX: 268, pageX: 268 },
      })
    )
    expect(props.onSelectEffort).toHaveBeenCalledWith('high')
  })
})
