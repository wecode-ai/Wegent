import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationMenuNative as AndroidMenu } from './ConversationMenuNative'
import { ConversationMenuNative as IOSMenu } from './ConversationMenuNative.ios'
import type { ConversationMenuNativeProps } from './ConversationMenuNative.types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-native', () => ({ Pressable: 'Pressable' }))
vi.mock('react-native-paper', () => ({ useTheme: () => ({ colors: { error: 'red' } }) }))
vi.mock('@expo/ui/swift-ui', () => ({
  Button: 'SwiftUIButton',
  Section: 'SwiftUISection',
  Host: 'SwiftUIHost',
  Menu: 'SwiftUIMenu',
  RNHostView: 'SwiftUIRNHost',
}))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  buttonStyle: (value: string) => ({ buttonStyle: value }),
  disabled: (value: boolean) => ({ disabled: value }),
}))
vi.mock('@expo/ui/jetpack-compose', async () => {
  const { createElement } = await import('react')
  const DropdownMenu = Object.assign(
    ({ children, ...props }: { children: React.ReactNode }) =>
      createElement('ComposeMenu', props, children),
    { Trigger: 'ComposeTrigger', Items: 'ComposeItems' }
  )
  const DropdownMenuItem = Object.assign(
    ({ children, ...props }: { children: React.ReactNode }) =>
      createElement('ComposeItem', props, children),
    { Text: 'ComposeItemText' }
  )
  return {
    DropdownMenu,
    DropdownMenuItem,
    HorizontalDivider: 'ComposeDivider',
    Host: 'ComposeHost',
    RNHostView: 'ComposeRNHost',
    Text: 'ComposeText',
  }
})
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  testID: (value: string) => ({ testID: value }),
}))

describe('native conversation menus', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  const props = (): ConversationMenuNativeProps => ({
    actions: [
      {
        id: 'conversation-archive',
        title: '归档',
        icon: 'archivebox',
        disabled: false,
        destructive: true,
        section: 'conversation',
      },
      {
        id: 'conversation-files',
        title: '文件',
        icon: 'folder',
        disabled: true,
        section: 'workspace',
      },
    ],
    children: React.createElement('Icon'),
    colorScheme: 'dark',
    disabled: false,
    onSelect: vi.fn(),
    title: 'Review project',
    width: 54,
  })

  it('uses SwiftUI presentation and action roles without a JavaScript visibility lifecycle', async () => {
    const options = props()
    await act(() => {
      renderer = create(<IOSMenu {...options} />)
    })
    const host = renderer.root.findByType('SwiftUIHost' as never)
    const menu = renderer.root.findByType('SwiftUIMenu' as never)
    expect(host.props.style).toEqual({ width: 54, height: 44 })
    expect(host.props.colorScheme).toBe('dark')
    expect(menu.props.testID).toBe('more-actions')
    expect(menu.props.onPrimaryAction).toBeUndefined()
    expect(menu.props.onOpenMenu).toBeUndefined()
    expect(menu.props.onCloseMenu).toBeUndefined()
    const buttons = renderer.root.findAllByType('SwiftUIButton' as never)
    expect(buttons[0]!.props.role).toBe('destructive')
    expect(buttons[0]!.props.testID).toBe('conversation-archive')
    expect(buttons[1]!.props.modifiers).toContainEqual({ disabled: true })
    await act(() => buttons[0]!.props.onPress())
    expect(options.onSelect).toHaveBeenCalledWith('conversation-archive')
  })

  it('disables the SwiftUI trigger while a mutation or dialog owns the menu', async () => {
    await act(() => {
      renderer = create(<IOSMenu {...props()} disabled width={44} />)
    })
    expect(renderer.root.findByType('SwiftUIMenu' as never).props.modifiers).toContainEqual({
      disabled: true,
    })
    expect(renderer.root.findByType('SwiftUIHost' as never).props.style).toEqual({
      width: 44,
      height: 44,
    })
  })

  it('preserves the conversation title in a system section without turning it into an action', async () => {
    await act(() => {
      renderer = create(<IOSMenu {...props()} />)
    })
    const sections = renderer.root.findAllByType('SwiftUISection' as never)
    expect(sections[0]!.props.title).toBe('Review project')
    expect(sections[0]!.findAllByType('SwiftUIButton' as never)).toHaveLength(1)
    expect(sections[1]!.props.title).toBeUndefined()
    await act(() => renderer.update(<IOSMenu {...props()} title="Updated title" />))
    expect(renderer.root.findAllByType('SwiftUISection' as never)[0]!.props.title).toBe(
      'Updated title'
    )
  })

  it('lets the Compose popup dismiss on back or outside tap, and reopen without stale state', async () => {
    await act(() => {
      renderer = create(<AndroidMenu {...props()} />)
    })
    const menu = () => renderer.root.findByType('ComposeMenu' as never)
    const trigger = renderer.root.findByType('Pressable' as never)
    expect(menu().props.expanded).toBe(false)
    await act(() => trigger.props.onPress())
    expect(menu().props.expanded).toBe(true)
    await act(() => menu().props.onDismissRequest())
    expect(menu().props.expanded).toBe(false)
    await act(() => trigger.props.onPress())
    expect(menu().props.expanded).toBe(true)
  })

  it('closes the Compose popup when dispatching an action and preserves disabled items and IDs', async () => {
    const options = props()
    await act(() => {
      renderer = create(<AndroidMenu {...options} />)
    })
    await act(() => renderer.root.findByType('Pressable' as never).props.onPress())
    const items = renderer.root.findAllByType('ComposeItem' as never)
    expect(items[0]!.props.modifiers).toEqual([{ testID: 'conversation-archive' }])
    expect(items[0]!.props.elementColors).toEqual({ textColor: 'red' })
    expect(items[1]!.props.enabled).toBe(false)
    await act(() => items[0]!.props.onClick())
    expect(renderer.root.findByType('ComposeMenu' as never).props.expanded).toBe(false)
    expect(options.onSelect).toHaveBeenCalledWith('conversation-archive')
  })
})
