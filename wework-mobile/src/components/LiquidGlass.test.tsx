import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LiquidGlassButton, LiquidGlassGroup, LiquidGlassSurface } from './LiquidGlass'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const native = vi.hoisted(() => ({
  platform: 'ios',
  available: true,
  apiAvailable: true,
  reduced: false,
  listeners: new Set<(value: boolean) => void>(),
  readTransparency: vi.fn<() => Promise<boolean>>(),
  removeSubscription: vi.fn(),
  checkAvailability: vi.fn(),
}))

vi.mock('expo-glass-effect', () => ({
  GlassContainer: 'GlassContainer',
  GlassView: 'GlassView',
  isLiquidGlassAvailable: () => {
    native.checkAvailability()
    return native.available
  },
  isGlassEffectAPIAvailable: () => native.apiAvailable,
}))

function flatten(style: unknown): Record<string, unknown> {
  return Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : ((style || {}) as Record<string, unknown>)
}

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    addEventListener: (_event: string, listener: (value: boolean) => void) => {
      native.listeners.add(listener)
      return {
        remove: () => {
          native.listeners.delete(listener)
          native.removeSubscription()
        },
      }
    },
    isReduceTransparencyEnabled: () => native.readTransparency(),
  },
  Appearance: { getColorScheme: () => 'light' },
  Platform: {
    get OS() {
      return native.platform
    },
  },
  Pressable: 'Pressable',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, flatten, hairlineWidth: 0.5 },
  processColor: (color: string) =>
    ({
      '#f7f7f7': 0xfff7f7f7,
      '#202020': 0xff202020,
      'rgba(0, 0, 0, 0.08)': 0x14000000,
      'rgba(255, 255, 255, 0.5)': 0x80ffffff,
    })[color],
}))

describe('native glass presentation', () => {
  const renderers: ReactTestRenderer[] = []

  beforeEach(() => {
    native.platform = 'ios'
    native.available = true
    native.apiAvailable = true
    native.reduced = false
    native.readTransparency.mockImplementation(async () => native.reduced)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    for (const renderer of renderers.splice(0)) await act(() => renderer.unmount())
  })

  async function render(children: React.ReactElement) {
    let renderer!: ReactTestRenderer
    await act(() => {
      renderer = create(children)
      renderers.push(renderer)
    })
    return renderer
  }

  const surface = (colorScheme: 'light' | 'dark' = 'light', backgroundColor?: string) => (
    <LiquidGlassSurface
      colorScheme={colorScheme}
      fallbackStyle={{ backgroundColor }}
      glassEffectStyle="clear"
      isInteractive={false}
      style={{ borderRadius: 24, height: 48 }}
      testID="surface"
    >
      <span>Content</span>
    </LiquidGlassSurface>
  )

  it('uses the real native group and surface while preserving native appearance props', async () => {
    const renderer = await render(
      <LiquidGlassGroup spacing={8} style={{ gap: 8 }}>
        {surface()}
        {surface('dark')}
      </LiquidGlassGroup>
    )

    expect(renderer.root.findAllByType('GlassContainer' as never)).toHaveLength(1)
    const surfaces = renderer.root.findAllByType('GlassView' as never)
    expect(surfaces).toHaveLength(2)
    expect(surfaces[0]!.props).toMatchObject({
      colorScheme: 'light',
      glassEffectStyle: 'clear',
      isInteractive: false,
    })
    expect(surfaces[1]!.props.colorScheme).toBe('dark')
    expect(native.readTransparency).toHaveBeenCalledOnce()
    expect(native.listeners.size).toBe(1)
  })

  it('uses an opaque Android surface without querying iOS glass or accessibility APIs', async () => {
    native.platform = 'android'
    const renderer = await render(surface('light', 'rgba(0, 0, 0, 0.08)'))

    expect(renderer.root.findAllByType('GlassView' as never)).toHaveLength(0)
    const view = renderer.root.findByType('View' as never)
    expect(flatten(view.props.style)).toMatchObject({
      backgroundColor: 'rgb(235, 235, 235)',
      borderColor: '#e7e7e7',
      borderWidth: 0.5,
      borderRadius: 24,
    })
    expect(native.checkAvailability).not.toHaveBeenCalled()
    expect(native.readTransparency).not.toHaveBeenCalled()
  })

  it.each(['available', 'apiAvailable'] as const)(
    'does not mount a native effect when %s is false',
    async capability => {
      native[capability] = false
      const renderer = await render(surface())

      expect(renderer.root.findAllByType('GlassView' as never)).toHaveLength(0)
      expect(native.readTransparency).not.toHaveBeenCalled()
    }
  )

  it('responds to reduced transparency and restores native glass when it is disabled', async () => {
    native.reduced = true
    const renderer = await render(surface('dark', 'rgba(255, 255, 255, 0.5)'))

    expect(renderer.root.findAllByType('GlassView' as never)).toHaveLength(0)
    expect(flatten(renderer.root.findByType('View' as never).props.style)).toMatchObject({
      backgroundColor: 'rgb(140, 140, 140)',
      borderColor: '#2c2c2e',
    })

    await act(() => native.listeners.forEach(listener => listener(false)))
    expect(renderer.root.findAllByType('GlassView' as never)).toHaveLength(1)
  })

  it('does not overwrite a settings change with an older in-flight preference read', async () => {
    let resolvePreference!: (value: boolean) => void
    native.readTransparency.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePreference = resolve
        })
    )
    const renderer = await render(surface())

    await act(() => native.listeners.forEach(listener => listener(true)))
    await act(() => resolvePreference(false))

    expect(renderer.root.findAllByType('GlassView' as never)).toHaveLength(0)
  })

  it('reports preference-read failure and remains usable with opaque controls', async () => {
    const failure = new Error('Accessibility preference unavailable')
    native.readTransparency.mockRejectedValue(failure)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const renderer = await render(surface())

      expect(warning).toHaveBeenCalledWith(
        'Unable to read the reduced transparency setting',
        failure
      )
      expect(renderer.root.findAllByType('GlassView' as never)).toHaveLength(0)
      expect(renderer.root.findByType('span').children).toEqual(['Content'])

      await act(() => native.listeners.forEach(listener => listener(false)))
      expect(renderer.root.findAllByType('GlassView' as never)).toHaveLength(1)
    } finally {
      warning.mockRestore()
    }
  })

  it('keeps disabled button semantics and disables native interaction', async () => {
    const renderer = await render(
      <LiquidGlassButton
        accessibilityLabel="New conversation"
        colorScheme="light"
        contentStyle={{ height: 44 }}
        disabled
        fallbackStyle={{}}
        onPress={vi.fn()}
        style={{ width: 44, height: 44 }}
        testID="new-conversation"
      >
        <span>New</span>
      </LiquidGlassButton>
    )

    expect(renderer.root.findByType('GlassView' as never).props.isInteractive).toBe(false)
    expect(renderer.root.findByType('Pressable' as never).props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'New conversation',
      accessibilityState: { disabled: true },
      disabled: true,
      testID: 'new-conversation',
    })
  })

  it('removes its shared native subscription when the last surface unmounts', async () => {
    const first = await render(surface())
    const second = await render(surface())

    await act(() => first.unmount())
    expect(native.removeSubscription).not.toHaveBeenCalled()
    await act(() => second.unmount())
    expect(native.removeSubscription).toHaveBeenCalledOnce()
    expect(native.listeners.size).toBe(0)
  })
})
