import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationHeader } from './ConversationHeader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

  it('keeps the capsule to new conversation and more, with files in the menu', async () => {
    await render()
    expect(elements('conversation-files')).toHaveLength(0)
    expect(elements('new-conversation')).toHaveLength(1)
    expect(elements('more-actions')).toHaveLength(1)
  })

  it('exposes the menu before sending the first message', async () => {
    const props = await render({ minimal: true })
    await act(() => elements('more-actions')[0]!.props.onPress())
    expect(props.onMore).toHaveBeenCalledOnce()
    expect(elements('new-conversation')).toHaveLength(0)
  })

  it('omits unavailable context without inventing a project', async () => {
    await render({ projectName: null })
    expect(elements('conversation-header-device')).toHaveLength(1)
    expect(elements('conversation-header-project')).toHaveLength(0)
  })

  it('keeps back navigation in the new-conversation header', async () => {
    const props = await render({ minimal: true })
    expect(elements('new-conversation')).toHaveLength(0)
    expect(elements('more-actions')).toHaveLength(1)
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
