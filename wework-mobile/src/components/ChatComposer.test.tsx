import { getDocumentAsync } from 'expo-document-picker'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatComposer } from './ChatComposer'
import type { MobileFilePreviewActions } from './files/FilePreviewContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const preview = vi.hoisted(() => ({ current: null as MobileFilePreviewActions | null }))
vi.mock('./files/FilePreviewContext', () => ({ useMobileFilePreview: () => preview.current }))

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }))
vi.mock('expo-image-picker', () => ({}))
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Image: 'Image',
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  TextInput: 'TextInput',
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  useTheme: () => ({
    dark: false,
    colors: {
      onSurface: '#111111',
      surface: '#ffffff',
      surfaceVariant: '#f3f3f3',
      onSurfaceVariant: '#777777',
      outlineVariant: '#eeeeee',
    },
  }),
}))
vi.mock('./LiquidGlass', () => ({
  LiquidGlassGroup: 'LiquidGlassGroup',
  LiquidGlassSurface: 'LiquidGlassSurface',
}))
vi.mock('./ComposerContextMenu', () => ({ ComposerContextMenu: 'ComposerContextMenu' }))

describe('ChatComposer', () => {
  let renderer: ReactTestRenderer
  const focus = vi.fn()
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    focus.mockClear()
    vi.mocked(getDocumentAsync).mockReset()
    preview.current = null
  })

  const element = (testID: string) =>
    renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!

  async function render(overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
    const props = {
      disabled: false,
      modelLabel: 'GPT-6 High',
      onLoadApps: vi.fn().mockResolvedValue([]),
      onClearPlanMode: vi.fn(),
      onSelectModel: vi.fn(),
      onSend: vi.fn().mockResolvedValue(true),
      onStop: vi.fn().mockResolvedValue(true),
      onSetPlanMode: vi.fn(),
      onUploadAttachment: vi.fn(),
      planModeActive: false,
      running: false,
      stopping: false,
      ...overrides,
    }
    await act(() => {
      renderer = create(<ChatComposer {...props} />, {
        createNodeMock: element => (element.type === 'TextInput' ? { focus } : null),
      })
    })
    return props
  }

  it('retains the draft and a single send control when the input expands', async () => {
    await render({ emptyContextPlaceholder: '向 Wework 提问' })
    expect(element('chat-input').props.placeholder).toBe('向 Wework 提问')
    await act(() => {
      element('chat-input').props.onChangeText('Review this project')
      element('chat-input').props.onFocus()
    })
    expect(element('chat-input').props.value).toBe('Review this project')
    expect(
      renderer.root.findAll(
        node => node.type === ('Pressable' as never) && node.props.testID === 'chat-send'
      )
    ).toHaveLength(1)
    await act(() => element('chat-input').props.onBlur())
    expect(element('chat-input').props.value).toBe('Review this project')
  })

  it('opens the model control with the current model announced by its icon', async () => {
    const props = await render()
    await act(() => element('chat-input').props.onFocus())
    expect(element('composer-model').props.accessibilityLabel).toContain('GPT-6 High')
    await act(() => element('composer-model').props.onPress())
    expect(props.onSelectModel).toHaveBeenCalledOnce()
  })

  it('allows attachment removal through its horizontal scroller while editing the draft', async () => {
    vi.mocked(getDocumentAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          name: 'notes.txt',
          uri: 'file:///notes.txt',
          mimeType: 'text/plain',
          size: 12,
          lastModified: 1,
        },
      ],
    })
    const props = await render({
      onUploadAttachment: vi.fn().mockResolvedValue({
        id: 7,
        filename: 'notes.txt',
        fileSize: 12,
        mimeType: 'text/plain',
      }),
    })
    await act(async () => {
      renderer.root.findByType('ComposerContextMenu' as never).props.onPickDocument()
    })
    await act(() => {
      element('chat-input').props.onFocus()
      element('chat-input').props.onChangeText('Keep this draft')
    })
    const strip = renderer.root.findByType('ScrollView' as never)
    expect(strip.props.horizontal).toBe(true)
    expect(strip.props.keyboardShouldPersistTaps).toBe('handled')
    await act(() => strip.findByProps({ testID: 'composer-attachment-remove-7' }).props.onPress())
    expect(renderer.root.findAllByProps({ testID: 'composer-attachment-remove-7' })).toHaveLength(0)
    expect(element('chat-input').props.value).toBe('Keep this draft')
    await act(() => element('chat-send').props.onPress())
    expect(props.onSend).toHaveBeenCalledWith('Keep this draft', {
      attachmentIds: [],
      attachments: [],
      pursueGoal: false,
    })
  })

  it.each([true, false])('clears the draft only after an accepted send (%s)', async accepted => {
    const onSend = vi.fn().mockResolvedValue(accepted)
    await render({ onSend })
    await act(() => element('chat-input').props.onChangeText('Review this project'))
    await act(() => element('chat-send').props.onPress())
    expect(onSend).toHaveBeenCalledWith('Review this project', {
      attachmentIds: [],
      attachments: [],
      pursueGoal: false,
    })
    expect(element('chat-input').props.value).toBe(accepted ? '' : 'Review this project')
  })

  it.each([true, false])(
    'previews every uploaded attachment and preserves it after rejected sends (context=%s)',
    async enabled => {
      const openAttachment = vi.fn()
      if (enabled)
        preview.current = { target: null, openAttachment } as unknown as MobileFilePreviewActions
      vi.mocked(getDocumentAsync).mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            name: 'notes.txt',
            uri: 'file:///notes.txt',
            mimeType: 'text/plain',
            size: 12,
            lastModified: 1,
          },
          {
            name: 'image.png',
            uri: 'file:///image.png',
            mimeType: 'image/png',
            size: 30,
            lastModified: 1,
          },
        ],
      })
      const props = await render({
        onSend: vi.fn().mockResolvedValue(false),
        onUploadAttachment: vi.fn().mockImplementation(async asset => ({
          id: asset.name === 'notes.txt' ? 7 : 8,
          filename: asset.name,
          fileSize: asset.size,
          mimeType: asset.mimeType,
        })),
      })
      await act(() =>
        renderer.root.findByType('ComposerContextMenu' as never).props.onPickDocument()
      )
      for (const id of [7, 8]) {
        expect(element(`composer-attachment-preview-${id}`).props.disabled).toBe(!enabled)
        if (enabled) await act(() => element(`composer-attachment-preview-${id}`).props.onPress())
      }
      if (enabled)
        expect(openAttachment.mock.calls.map(([attachment]) => attachment.filename)).toEqual([
          'notes.txt',
          'image.png',
        ])
      await act(() => element('chat-input').props.onChangeText('Review both'))
      await act(() => element('chat-send').props.onPress())
      expect(props.onSend).toHaveBeenCalledWith(
        'Review both',
        expect.objectContaining({
          attachmentIds: [7, 8],
          attachments: [
            expect.objectContaining({
              id: 7,
              filename: 'notes.txt',
              file_size: 12,
              mime_type: 'text/plain',
              status: 'ready',
            }),
            expect.objectContaining({
              id: 8,
              filename: 'image.png',
              file_size: 30,
              mime_type: 'image/png',
              local_preview_url: 'file:///image.png',
            }),
          ],
        })
      )
      expect(element('composer-attachment-preview-7')).toBeDefined()
      expect(element('composer-attachment-preview-8')).toBeDefined()
      expect(vi.mocked(props.onSend).mock.calls[0]?.[1].attachments[0]).not.toHaveProperty(
        'local_path'
      )
    }
  )

  it('keeps stopping in the existing action slot and disables repeated cancellation', async () => {
    const props = await render({ running: true })
    expect(element('chat-stop').props.disabled).toBe(false)
    await act(() => element('chat-stop').props.onPress())
    expect(props.onStop).toHaveBeenCalledOnce()
    await act(() => renderer.update(<ChatComposer {...props} stopping />))
    expect(element('chat-stop').props.disabled).toBe(true)
    expect(element('chat-stop').props.accessibilityState.disabled).toBe(true)
  })

  it('focuses a requested new conversation once without stealing focus on model changes', async () => {
    const props = await render()
    expect(focus).not.toHaveBeenCalled()
    await act(() => renderer.update(<ChatComposer {...props} focusRequest={1} />))
    expect(focus).toHaveBeenCalledOnce()
    await act(() => element('chat-input').props.onChangeText('Keep this draft'))
    await act(() =>
      renderer.update(<ChatComposer {...props} focusRequest={1} modelLabel="Other" />)
    )
    expect(focus).toHaveBeenCalledOnce()
    expect(element('chat-input').props.value).toBe('Keep this draft')
    await act(() => renderer.update(<ChatComposer {...props} focusRequest={2} />))
    expect(focus).toHaveBeenCalledTimes(2)
  })

  it('defers requested focus until the input can become editable', async () => {
    const props = await render({ disabled: true, focusRequest: 1 })
    expect(focus).not.toHaveBeenCalled()
    await act(() => renderer.update(<ChatComposer {...props} disabled={false} />))
    expect(focus).toHaveBeenCalledOnce()
  })

  it('shows the speed shortcut only when the selected model supplies a real action', async () => {
    const props = await render()
    await act(() => element('chat-input').props.onFocus())
    expect(renderer.root.findAllByProps({ testID: 'composer-speed' })).toHaveLength(0)
    const onToggleSpeed = vi.fn()
    await act(() =>
      renderer.update(<ChatComposer {...props} speed="fast" onToggleSpeed={onToggleSpeed} />)
    )
    expect(element('composer-speed').props.accessibilityState.selected).toBe(true)
    await act(() => element('composer-speed').props.onPress())
    expect(onToggleSpeed).toHaveBeenCalledOnce()
  })
})
