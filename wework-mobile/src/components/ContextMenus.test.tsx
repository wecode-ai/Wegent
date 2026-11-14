import React from 'react'
import { StyleSheet } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerContextMenu } from './ComposerContextMenu'
import { MessageContextMenu } from './MessageContextMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const environment = vi.hoisted(() => ({
  window: { width: 375, height: 667 },
  insets: { top: 20, bottom: 34, left: 0, right: 0 },
  keyboard: { height: 0, isVisible: false },
}))

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (style: unknown) =>
      Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style,
  },
  useWindowDimensions: () => environment.window,
  View: 'View',
}))
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: <T,>(selector: (state: typeof environment.keyboard) => T) =>
    selector(environment.keyboard),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => environment.insets,
}))
vi.mock('react-native-paper', () => ({
  Portal: 'Portal',
  Text: 'Text',
  useTheme: () => ({
    dark: false,
    colors: { elevation: { level3: '#fff' }, onSurface: '#111', outlineVariant: '#ddd' },
  }),
}))
vi.mock('./LiquidGlass', () => ({ LiquidGlassSurface: 'LiquidGlassSurface' }))

describe('context menus within the keyboard and safe-area viewport', () => {
  let renderer: ReactTestRenderer | undefined
  const find = (testID: string) => renderer!.root.findByProps({ testID })
  const frame = (testID: string) => StyleSheet.flatten(find(testID).props.style)

  beforeEach(() => {
    environment.window = { width: 375, height: 667 }
    environment.insets = { top: 20, bottom: 34, left: 0, right: 0 }
    environment.keyboard = { height: 0, isVisible: false }
  })

  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = undefined
  })

  async function renderMessage(anchor = { x: 180, y: 320 }) {
    const props = { anchor, onCopy: vi.fn(), onDismiss: vi.fn() }
    await act(() => {
      renderer = create(<MessageContextMenu {...props} />)
    })
    return props
  }

  async function renderComposer(anchor = { x: 12, y: 260, width: 351, height: 68 }) {
    const props = {
      anchor,
      goalDraftActive: false,
      onDismiss: vi.fn(),
      onLoadApps: vi.fn().mockResolvedValue([]),
      onPickDocument: vi.fn(),
      onPickPhoto: vi.fn(),
      onSelectApp: vi.fn(),
      onSetGoal: vi.fn(),
      onSetPlanMode: vi.fn(),
      onTakePhoto: vi.fn(),
      planModeActive: false,
      visible: true,
    }
    await act(() => {
      renderer = create(<ComposerContextMenu {...props} />)
    })
    return props
  }

  it('moves the copy menu above its unchanged anchor when the keyboard occupies the space below', async () => {
    const props = await renderMessage()
    expect(frame('message-context-menu').top).toBeGreaterThan(props.anchor.y)

    environment.keyboard = { height: 320, isVisible: true }
    await act(() => renderer!.update(<MessageContextMenu {...props} />))
    const { top } = frame('message-context-menu')
    expect(top).toBeLessThan(props.anchor.y)
    expect(top + 52).toBeLessThanOrEqual(667 - 320 - 12)
    await act(() => find('message-copy').props.onPress())
    expect(props.onCopy).toHaveBeenCalledOnce()
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it.each([
    { x: -10, y: -10 },
    { x: 500, y: 800 },
  ])('clamps the copy menu inside safe edges for an out-of-bounds anchor %o', async anchor => {
    environment.insets = { top: 59, bottom: 34, left: 24, right: 24 }
    environment.keyboard = { height: 320, isVisible: true }
    await renderMessage(anchor)
    const { left, top, width } = frame('message-context-menu')
    expect(left).toBeGreaterThanOrEqual(24 + 12)
    expect(left + width).toBeLessThanOrEqual(375 - 24 - 12)
    expect(top).toBeGreaterThanOrEqual(59 + 12)
    expect(top + 52).toBeLessThanOrEqual(667 - 320 - 12)
  })

  it('fits the composer menu above its anchor on a small screen with the keyboard open', async () => {
    environment.insets = { top: 59, bottom: 34, left: 24, right: 24 }
    environment.keyboard = { height: 320, isVisible: true }
    const props = await renderComposer()
    const { left, top, width, height } = frame('composer-menu-positioner')
    expect(top).toBeGreaterThanOrEqual(59 + 12)
    expect(top + height).toBeLessThanOrEqual(props.anchor.y - 8)
    expect(top + height).toBeLessThanOrEqual(667 - 320 - 12)
    expect(height).toBeGreaterThan(0)
    expect(height).toBeLessThan(280)
    expect(left).toBeGreaterThanOrEqual(24 + 12)
    expect(left + width).toBeLessThanOrEqual(375 - 24 - 12)
  })

  it('keeps a composer menu inside a taller keyboard even when its measured anchor is stale', async () => {
    environment.keyboard = { height: 320, isVisible: true }
    const props = await renderComposer()
    environment.keyboard = { height: 450, isVisible: true }
    await act(() => renderer!.update(<ComposerContextMenu {...props} />))
    const { top, height } = frame('composer-menu-positioner')
    expect(top).toBeGreaterThanOrEqual(20 + 12)
    expect(height).toBeGreaterThan(0)
    expect(top + height).toBeLessThanOrEqual(667 - 450 - 12)
  })

  it('allows the first action tap through the scroll view while the keyboard remains open', async () => {
    environment.keyboard = { height: 320, isVisible: true }
    const props = await renderComposer()
    const scroll = find('composer-menu-scroll')
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled')
    await act(() => scroll.findByProps({ testID: 'composer-menu-plan' }).props.onPress())
    expect(props.onSetPlanMode).toHaveBeenCalledOnce()
    expect(props.onDismiss).toHaveBeenCalledOnce()
    expect(props.onDismiss.mock.invocationCallOrder[0]).toBeLessThan(
      props.onSetPlanMode.mock.invocationCallOrder[0]!
    )
  })
})
