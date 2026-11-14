import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationHeader } from './ConversationHeader'
import type { MobileFilePreviewActions } from './files/FilePreviewContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const preview = vi.hoisted(() => ({ current: null as MobileFilePreviewActions | null }))
vi.mock('./files/FilePreviewContext', () => ({ useMobileFilePreview: () => preview.current }))

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ dark: false, colors: {} }),
}))
vi.mock('./LiquidGlass', () => ({
  LiquidGlassButton: 'LiquidGlassButton',
  LiquidGlassGroup: 'LiquidGlassGroup',
  LiquidGlassSurface: 'LiquidGlassSurface',
}))

describe('ConversationHeader', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    preview.current = null
  })

  const elements = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)

  async function render(overrides: Partial<React.ComponentProps<typeof ConversationHeader>> = {}) {
    const props = {
      title: 'Review project',
      deviceName: 'A computer with a long name',
      projectName: 'Wegent',
      onBack: vi.fn(),
      onNewConversation: vi.fn(),
      onMore: vi.fn(),
      ...overrides,
    }
    await act(() => {
      renderer = create(<ConversationHeader {...props} />)
    })
    return props
  }

  it('keeps device and project as independently readable context', async () => {
    await render()
    expect(elements('conversation-header-device')[0]!.props.children).toBe(
      'A computer with a long name'
    )
    expect(elements('conversation-header-project')[0]!.props.children).toBe('Wegent')
  })

  it.each([true, false])(
    'opens the browser only when a workspace is available (%s)',
    async available => {
      const openBrowser = vi.fn()
      preview.current = {
        target: available ? { deviceId: 'storage', path: '/worktree' } : null,
        openBrowser,
      } as unknown as MobileFilePreviewActions
      await render()
      expect(elements('conversation-files')[0]!.props.disabled).toBe(!available)
      if (available) await act(() => elements('conversation-files')[0]!.props.onPress())
      expect(openBrowser).toHaveBeenCalledTimes(available ? 1 : 0)
    }
  )

  it('omits file browsing outside the preview provider', async () => {
    await render()
    expect(elements('conversation-files')).toHaveLength(0)
  })

  it('also exposes the selected workspace browser before sending the first message', async () => {
    const openBrowser = vi.fn()
    preview.current = {
      target: { deviceId: 'storage', path: '/selected' },
      openBrowser,
    } as unknown as MobileFilePreviewActions
    await render({ minimal: true })
    await act(() => elements('conversation-files')[0]!.props.onPress())
    expect(openBrowser).toHaveBeenCalledOnce()
    expect(elements('new-conversation')).toHaveLength(0)
    expect(elements('more-actions')).toHaveLength(0)
  })

  it('omits unavailable context without inventing a project', async () => {
    await render({ projectName: null })
    expect(elements('conversation-header-device')).toHaveLength(1)
    expect(elements('conversation-header-project')).toHaveLength(0)
  })

  it('keeps only back navigation in the new-conversation header', async () => {
    const props = await render({ minimal: true })
    expect(elements('new-conversation')).toHaveLength(0)
    expect(elements('more-actions')).toHaveLength(0)
    await act(() => elements('open-drawer')[0]!.props.onPress())
    expect(props.onBack).toHaveBeenCalledOnce()
  })

  it('preserves new-conversation capability and the more action', async () => {
    const props = await render({ canCreateConversation: false })
    expect(elements('new-conversation')[0]!.props.disabled).toBe(true)
    await act(() => elements('more-actions')[0]!.props.onPress())
    expect(props.onMore).toHaveBeenCalledOnce()
  })
})
