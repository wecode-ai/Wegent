import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationMenu } from './ConversationMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const files = vi.hoisted(() => ({
  target: { deviceId: 'device', path: '/repo' } as object | null,
  openBrowser: vi.fn(),
  openChangesBrowser: vi.fn(),
}))
const clipboard = vi.hoisted(() => vi.fn())
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }))
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
  View: 'View',
}))
vi.mock('react-native-paper', () => {
  const Dialog = Object.assign(
    ({ children, ...props }: { children: React.ReactNode }) =>
      React.createElement('Dialog', props, children),
    { Title: 'DialogTitle', Content: 'DialogContent', Actions: 'DialogActions' }
  )
  return {
    Button: 'Button',
    Dialog,
    Portal: 'Portal',
    Text: 'Text',
    TextInput: 'TextInput',
    useTheme: () => ({ dark: false, colors: { elevation: { level3: 'white' } } }),
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 60, bottom: 34 }),
}))
vi.mock('./LiquidGlass', () => ({ LiquidGlassSurface: 'Glass' }))
vi.mock('./ConversationMenuSurface', async () => {
  const { useImperativeHandle, createElement } = await import('react')
  return {
    ConversationMenuSurface: ({
      ref,
      children,
      busy,
      onDismiss,
    }: {
      ref: React.Ref<{ close: (after?: () => void) => void }>
      children: (ready: boolean) => React.ReactNode
      busy: boolean
      onDismiss: () => void
    }) => {
      useImperativeHandle(ref, () => ({
        close: (after?: () => void) => {
          onDismiss()
          after?.()
        },
      }))
      return createElement(
        'Surface',
        {},
        createElement('Pressable', { testID: 'conversation-menu-dismiss', disabled: busy }),
        children(!busy)
      )
    },
  }
})
vi.mock('./files/FilePreviewContext', () => ({ useMobileFilePreview: () => files }))

describe('conversation menu', () => {
  let renderer: ReactTestRenderer
  const props = {
    threadId: 'thread-1',
    address: { deviceId: 'device', taskId: 'task' },
    title: 'Conversation',
    visible: true,
    anchor: { x: 271, y: 60, width: 108, height: 44 },
    canPin: true,
    pinned: false,
    onPin: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onSettings: vi.fn(),
    onDismiss: vi.fn(),
  }
  const element = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!
  beforeEach(async () => {
    vi.resetAllMocks()
    files.target = { deviceId: 'device', path: '/repo' }
    await act(() => {
      renderer = create(<ConversationMenu {...props} />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })
  it('routes files and changes to their corresponding workspace views', async () => {
    await act(() => element('conversation-files').props.onPress())
    expect(files.openBrowser).toHaveBeenCalledOnce()
    await act(() => element('conversation-changes').props.onPress())
    expect(files.openChangesBrowser).toHaveBeenCalledOnce()
  })
  it('keeps the original connection settings available from the extended menu', async () => {
    await act(() => element('conversation-settings').props.onPress())
    expect(props.onDismiss).toHaveBeenCalledOnce()
    expect(props.onSettings).toHaveBeenCalledOnce()
    expect(props.onDismiss.mock.invocationCallOrder[0]).toBeLessThan(
      props.onSettings.mock.invocationCallOrder[0]!
    )
  })
  it('keeps connection settings available before a conversation or workspace exists', async () => {
    files.target = null
    await act(() => renderer.update(<ConversationMenu {...props} address={null} canPin={false} />))
    expect(element('conversation-settings').props.disabled).toBe(false)
  })
  it('disables file operations without a workspace and task operations before task creation', async () => {
    files.target = null
    await act(() => renderer.update(<ConversationMenu {...props} address={null} canPin={false} />))
    for (const id of [
      'conversation-files',
      'conversation-changes',
      'conversation-pin',
      'conversation-rename',
      'conversation-copy-id',
      'conversation-archive',
    ])
      expect(element(id).props.disabled).toBe(true)
  })
  it('copies the conversation ID through the platform clipboard', async () => {
    await act(() => element('conversation-copy-id').props.onPress())
    expect(clipboard).toHaveBeenCalledWith('thread-1')
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })
  it('keeps a rejected mutation visible with the real error', async () => {
    props.onPin.mockRejectedValue(new Error('device offline'))
    await act(() => element('conversation-pin').props.onPress())
    expect(props.onDismiss).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ accessibilityRole: 'alert' })[0]!.props.children).toBe(
      'device offline'
    )
  })
  it('does not substitute a task ID when the conversation thread is not established', async () => {
    await act(() => renderer.update(<ConversationMenu {...props} threadId={null} />))
    expect(element('conversation-copy-id').props.disabled).toBe(true)
    await act(() => element('conversation-copy-id').props.onPress())
    expect(clipboard).not.toHaveBeenCalled()
  })
  it('opens a rename form and submits the entered title', async () => {
    await act(() => element('conversation-rename').props.onPress())
    await act(() => element('conversation-rename-input').props.onChangeText(' New title '))
    await act(() => element('conversation-rename-save').props.onPress())
    expect(props.onRename).toHaveBeenCalledWith('New title')
  })
  it('keeps mutations disabled while an archive is in flight', async () => {
    let complete!: () => void
    props.onArchive.mockReturnValue(
      new Promise<void>(resolve => {
        complete = resolve
      })
    )
    await act(() => element('conversation-archive').props.onPress())
    expect(element('conversation-archive').props.disabled).toBe(true)
    expect(element('conversation-menu-dismiss').props.disabled).toBe(true)
    await act(async () => {
      complete()
      await Promise.resolve()
    })
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })
})
