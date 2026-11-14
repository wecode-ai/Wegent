import React from 'react'
import { Alert, Linking } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import { FilePreviewContext, type MobileFilePreviewActions } from './files/FilePreviewContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}))
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: 'Markdown' }))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ colors: { elevation: { level1: '#fff', level2: '#eee' } } }),
}))

describe('AssistantMarkdown preview links', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    vi.clearAllMocks()
  })
  async function render(
    context: MobileFilePreviewActions | null = null,
    content = '[file](src/main.ts) ![external](https://images.example/test.png)'
  ) {
    await act(() => {
      renderer = create(
        <FilePreviewContext.Provider value={context}>
          <AssistantMarkdown>{content}</AssistantMarkdown>
        </FilePreviewContext.Provider>
      )
    })
    return renderer.root.findByType('Markdown' as never)
  }
  it('delegates file and external links to the unified preview routing without image credentials', async () => {
    const openLink = vi.fn()
    const markdown = await render({ target: null, openLink } as unknown as MobileFilePreviewActions)
    for (const url of ['src/main.ts#L10', 'https://example.test'])
      await act(() => markdown.props.onLinkPress({ url }))
    expect(openLink.mock.calls).toEqual([['src/main.ts#L10'], ['https://example.test']])
    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(markdown.props.imageRequestHeaders).toBeUndefined()
  })
  it.each([true, false])(
    'provides deduplicated file-image preview entries without network work during streaming (%s)',
    async available => {
      const openLink = vi.fn()
      await render(
        {
          target: available ? { deviceId: 'cloud', path: '/workspace' } : null,
          openLink,
        } as unknown as MobileFilePreviewActions,
        '![绝对图](/workspace/output.png) ![相对图](<images/a b.webp>) ![重复](/workspace/output.png) ![外部图](https://images.example/test.png)'
      )
      const buttons = renderer.root.findAll(node => node.type === ('Pressable' as never))
      expect(buttons).toHaveLength(2)
      expect(openLink).not.toHaveBeenCalled()
      expect(Linking.openURL).not.toHaveBeenCalled()
      for (const button of buttons) {
        expect(button.props.disabled).toBe(!available)
        if (available) await act(() => button.props.onPress())
      }
      if (available)
        expect(openLink.mock.calls).toEqual([['/workspace/output.png'], ['images/a b.webp']])
    }
  )
  it('opens safe external links without a workspace and shows native open errors', async () => {
    const markdown = await render()
    await act(() => markdown.props.onLinkPress({ url: 'https://example.test' }))
    expect(Linking.openURL).toHaveBeenCalledWith('https://example.test')
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('No browser available'))
    await act(() => markdown.props.onLinkPress({ url: 'https://example.test/failure' }))
    expect(Alert.alert).toHaveBeenCalledWith('无法打开链接', 'No browser available')
  })
  it.each(['src/main.ts', 'file:///etc/hosts', 'javascript:alert(1)'])(
    'never dispatches unavailable file or unsafe links to the OS: %s',
    async url => {
      const markdown = await render()
      await act(() => markdown.props.onLinkPress({ url }))
      expect(Linking.openURL).not.toHaveBeenCalled()
      expect(Alert.alert).toHaveBeenCalledOnce()
    }
  )
})
