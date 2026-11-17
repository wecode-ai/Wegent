import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanResponderCallbacks } from 'react-native'
import { SwipeArchiveRow } from './SwipeArchiveRow'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const motion = vi.hoisted(() => ({
  config: {} as PanResponderCallbacks,
  spring: vi.fn(),
  scale: 1,
}))
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ fontScale: motion.scale }),
  Animated: {
    Value: class {
      setValue = vi.fn()
      stopAnimation = vi.fn()
    },
    View: 'AnimatedView',
    spring: (...args: unknown[]) => {
      motion.spring(...args)
      return { start: vi.fn(), stop: vi.fn() }
    },
  },
  PanResponder: {
    create: (config: PanResponderCallbacks) => {
      motion.config = config
      return { panHandlers: {} }
    },
  },
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ colors: { error: 'red', onError: 'white', background: 'white' } }),
}))
let renderer: ReactTestRenderer
const props = {
  open: false,
  disabled: false,
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onSwipeStart: vi.fn(),
  onPress: vi.fn(),
  onArchive: vi.fn(),
  testID: 'swipe-row',
  children: (onPress: () => void) => React.createElement('Row', { onPress }),
}
const gesture = (dx: number, dy = 0, vx = 0) =>
  ({ dx, dy, vx }) as Parameters<NonNullable<PanResponderCallbacks['onPanResponderMove']>>[1]
const event = {} as Parameters<NonNullable<PanResponderCallbacks['onPanResponderMove']>>[0]
const archive = () =>
  renderer.root.findAll(
    node =>
      node.type === ('Pressable' as React.ElementType) && node.props.testID === 'swipe-row-archive'
  )[0]!
beforeEach(async () => {
  vi.clearAllMocks()
  motion.scale = 1
  await act(() => {
    renderer = create(<SwipeArchiveRow {...props} />)
  })
})
afterEach(async () => {
  await act(() => renderer.unmount())
})
describe('left-swipe archive affordance', () => {
  it('captures horizontal left intent while preserving vertical scrolling and ordinary taps', () => {
    expect(motion.config.onMoveShouldSetPanResponder!(event, gesture(-50, 3))).toBe(true)
    expect(motion.config.onMoveShouldSetPanResponder!(event, gesture(-4, 50))).toBe(false)
    expect(motion.config.onMoveShouldSetPanResponder!(event, gesture(50, 2))).toBe(false)
    expect(motion.config.onMoveShouldSetPanResponder!(event, gesture(-3, 0))).toBe(false)
  })
  it('only reveals the action after even a full swipe; archival requires a button press', async () => {
    await act(() => {
      motion.config.onPanResponderGrant!(event, gesture(0))
      motion.config.onPanResponderMove!(event, gesture(-500))
      motion.config.onPanResponderRelease!(event, gesture(-500))
    })
    expect(props.onOpen).toHaveBeenCalledOnce()
    expect(props.onArchive).not.toHaveBeenCalled()
    expect(props.onPress).not.toHaveBeenCalled()
    await act(() => renderer.update(<SwipeArchiveRow {...props} open />))
    await act(() => archive().props.onPress())
    expect(props.onArchive).toHaveBeenCalledOnce()
    expect(props.onClose).toHaveBeenCalledOnce()
  })
  it('settles a cancelled short drag without leaving partially shifted content', async () => {
    await act(() => {
      motion.config.onPanResponderGrant!(event, gesture(0))
      motion.config.onPanResponderMove!(event, gesture(-18))
      motion.config.onPanResponderRelease!(event, gesture(-18))
    })
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(motion.spring).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 0, useNativeDriver: true })
    )
    expect(props.onArchive).not.toHaveBeenCalled()
  })
  it('closes an open row on tap instead of navigating, and opens a closed conversation on tap', async () => {
    await act(() => renderer.root.findByType('Row' as never).props.onPress())
    expect(props.onPress).toHaveBeenCalledOnce()
    await act(() => renderer.update(<SwipeArchiveRow {...props} open />))
    await act(() => renderer.root.findByType('Row' as never).props.onPress())
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onPress).toHaveBeenCalledTimes(1)
  })
  it('blocks swipe and hidden archive actions while busy', async () => {
    expect(archive().props.disabled).toBe(true)
    await act(() => archive().props.onPress())
    expect(props.onArchive).not.toHaveBeenCalled()
    await act(() => renderer.update(<SwipeArchiveRow {...props} disabled open />))
    expect(motion.config.onMoveShouldSetPanResponder!(event, gesture(-50))).toBe(false)
    await act(() => archive().props.onPress())
    expect(props.onArchive).not.toHaveBeenCalled()
  })
  it('returns to the closed state when a native scroll or cancellation takes the gesture', async () => {
    await act(() => motion.config.onPanResponderTerminate!(event, gesture(-40)))
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onArchive).not.toHaveBeenCalled()
  })
})
