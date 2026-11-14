import React, { createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationMenuSurface,
  type ConversationMenuSurfaceHandle,
} from './ConversationMenuSurface'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const environment = vi.hoisted(() => ({
  viewport: { width: 393, height: 852 },
  callbacks: [] as Array<(finished: boolean) => void>,
  configs: [] as object[],
  backHandlers: new Set<() => boolean>(),
  cancel: vi.fn(),
}))
vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      environment.backHandlers.add(handler)
      return { remove: () => environment.backHandlers.delete(handler) }
    },
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  useWindowDimensions: () => environment.viewport,
}))
vi.mock('react-native-paper', () => ({
  useTheme: () => ({ dark: false, colors: { elevation: { level3: 'white' } } }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 60, bottom: 34, left: 0, right: 0 }),
}))
vi.mock('./LiquidGlass', () => ({ LiquidGlassSurface: 'Glass' }))
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { View: 'AnimatedView' },
    Easing: { out: (value: unknown) => value, cubic: 'cubic' },
    ReduceMotion: { System: 'system' },
    cancelAnimation: environment.cancel,
    runOnJS: (callback: unknown) => callback,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: number) => useRef({ value }).current,
    withTiming: (value: number, config: object, callback: (finished: boolean) => void) => {
      environment.configs.push(config)
      environment.callbacks.push(callback)
      return value
    },
  }
})

describe('conversation capsule expansion', () => {
  let renderer: ReactTestRenderer
  const surface = createRef<ConversationMenuSurfaceHandle>()
  const onDismiss = vi.fn()
  const props = {
    anchor: { x: 271, y: 60, width: 108, height: 44 },
    busy: false,
    onDismiss,
    children: (interactive: boolean) => React.createElement('MenuContent', { interactive }),
  }
  const element = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!
  const ready = () => renderer.root.findByType('MenuContent' as never).props.interactive
  const measure = async () => {
    await act(() => element('conversation-menu-overlay').props.onLayout())
    await act(() => element('conversation-menu-scroll').props.onContentSizeChange(245, 400))
  }
  beforeEach(async () => {
    onDismiss.mockClear()
    environment.callbacks.length = 0
    environment.configs.length = 0
    environment.cancel.mockClear()
    environment.viewport = { width: 393, height: 852 }
    await act(() => {
      renderer = create(<ConversationMenuSurface {...props} ref={surface} />, {
        createNodeMock: node =>
          (node.props as { testID?: string }).testID === 'conversation-menu-overlay'
            ? { measureInWindow: (callback: (x: number, y: number) => void) => callback(10, 20) }
            : null,
      })
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })
  it('measures its portal origin and content before opening, without enabling actions early', async () => {
    expect(ready()).toBe(false)
    expect(environment.callbacks).toHaveLength(0)
    await measure()
    expect(environment.callbacks).toHaveLength(1)
    expect(environment.configs[0]).toMatchObject({ reduceMotion: 'system' })
    expect(ready()).toBe(false)
    await act(() => environment.callbacks[0]!(true))
    expect(ready()).toBe(true)
    const frame = element('conversation-menu-frame').props.style[1]
    expect(frame).toMatchObject({ left: 124, top: 40, width: 245, height: 400 })
  })
  it('restores the capsule before opening the next layer and ignores duplicate close requests', async () => {
    await measure()
    await act(() => environment.callbacks[0]!(true))
    const next = vi.fn()
    await act(() => {
      surface.current!.close(next)
      surface.current!.close(next)
    })
    expect(ready()).toBe(false)
    expect(element('conversation-menu-dismiss').props.disabled).toBe(true)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(environment.callbacks).toHaveLength(2)
    await act(() => environment.callbacks[1]!(true))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
    expect(onDismiss.mock.invocationCallOrder[0]).toBeLessThan(next.mock.invocationCallOrder[0]!)
  })
  it('routes Android back through the reverse animation', async () => {
    await measure()
    await act(() => environment.callbacks[0]!(true))
    await act(() => expect([...environment.backHandlers][0]!()).toBe(true))
    expect(onDismiss).not.toHaveBeenCalled()
    await act(() => environment.callbacks[1]!(true))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('blocks dismissal while a mutation is pending', async () => {
    await act(() => renderer.update(<ConversationMenuSurface {...props} ref={surface} busy />))
    await act(() => {
      ;[...environment.backHandlers][0]!()
    })
    expect(element('conversation-menu-dismiss').props.disabled).toBe(true)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(environment.callbacks).toHaveLength(0)
  })
  it('dismisses a stale measured anchor when the screen rotates', async () => {
    environment.viewport = { width: 852, height: 393 }
    await act(() => renderer.update(<ConversationMenuSurface {...props} ref={surface} />))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
