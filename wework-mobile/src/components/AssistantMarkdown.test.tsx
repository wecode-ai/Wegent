import { showErrorAlert } from '@/services/errorAlerts'
import React from 'react'
import { Linking } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import { FilePreviewContext, type MobileFilePreviewActions } from './files/FilePreviewContext'

const nativeRender = vi.hoisted(() => vi.fn())
const appearance = vi.hoisted(() => ({
  colors: {
    primary: '#0278c2',
    primaryContainer: '#def1ff',
    elevation: { level1: '#fff', level2: '#eee' },
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/services/errorAlerts', () => ({
  showErrorAlert: vi.fn(),
  copyErrorDetails: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}))
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: (props: Record<string, unknown>) => {
    nativeRender(props)
    return React.createElement('Markdown', props)
  },
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn().mockResolvedValue(undefined) }))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => appearance,
}))

describe('AssistantMarkdown preview links', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
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
    return renderer!.root.findByType('Markdown' as never)
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

  it('styles a labelled GitHub PR and a workspace skill as inline references', async () => {
    const url = 'https://github.com/wecode-ai/Wegent/pull/4697'
    const markdown = await render(
      null,
      `[#4697](${url})，按 [PR Review 技能](/work/SKILL.md) 回写 Issue。`
    )
    const variants = Object.entries(markdown.props.markdownStyle.linkVariants)
    const variantFor = (link: string) =>
      variants.find(([pattern]) => new RegExp(pattern).test(link))?.[1]
    expect(variantFor(url)).toMatchObject({ underline: false, backgroundColor: '#def1ff' })
    expect(variantFor('/work/SKILL.md')).toMatchObject({ color: '#0278c2', underline: false })
    expect(variantFor('https://github.com.example/pull/4697')).toBeUndefined()
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
      const buttons = renderer!.root.findAll(node => node.type === ('Pressable' as never))
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
    expect(showErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'No browser available' }),
      { title: '无法打开链接' }
    )
  })
  it.each(['src/main.ts', 'file:///etc/hosts', 'javascript:alert(1)'])(
    'never dispatches unavailable file or unsafe links to the OS: %s',
    async url => {
      const markdown = await render()
      await act(() => markdown.props.onLinkPress({ url }))
      expect(Linking.openURL).not.toHaveBeenCalled()
      expect(showErrorAlert).toHaveBeenCalledOnce()
    }
  )

  it('uses native selection, Markdown copy and progressive code headers on both platforms', async () => {
    const markdown = await render(null, '```ts\nconst answer = 42\n```')
    expect(markdown.props).toMatchObject({
      selectable: true,
      allowFontScaling: true,
      flavor: 'github',
      selectionMenuConfig: { copy: { label: '复制' }, copyAsMarkdown: { enabled: true } },
      streamingConfig: { codeBlockMode: 'progressive', tableMode: 'progressive' },
    })
    await act(() => markdown.props.contextMenuItems[0].onPress())
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('```ts\nconst answer = 42\n```')
  })

  it('reuses a stable leading section and copies the latest whole reply from any chunk', async () => {
    const prefix = `# First\n${'Paragraph text. '.repeat(300)}\n`
    const content = `${prefix}## Second\nInitial tail`
    await act(() => {
      renderer = create(<AssistantMarkdown>{content}</AssistantMarkdown>)
    })
    const leading = renderer!.root.findAllByType('Markdown' as never)[0]!
    expect(renderer!.root.findAllByType('Markdown' as never)).toHaveLength(2)
    nativeRender.mockClear()
    const updated = `${content} with more text`
    await act(() => renderer!.update(<AssistantMarkdown>{updated}</AssistantMarkdown>))
    expect(renderer!.root.findAllByType('Markdown' as never)[0]).toBe(leading)
    expect(nativeRender.mock.calls.map(([props]) => props.markdown)).toEqual([
      '## Second\nInitial tail with more text',
    ])
    await act(() => leading.props.contextMenuItems[0].onPress())
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(updated)
  })

  it('keeps reference definitions with their uses and does not split headings inside code', async () => {
    const prefix = `${'Paragraph. '.repeat(400)}\n`
    for (const content of [
      `${prefix}[link][ref]\n## Next\nText\n\n[ref]: https://example.test`,
      `${prefix}\n\`\`\`md\n## A code heading\n${'code\n'.repeat(40)}\`\`\``,
    ]) {
      await act(() => {
        if (renderer) renderer.update(<AssistantMarkdown>{content}</AssistantMarkdown>)
        else renderer = create(<AssistantMarkdown>{content}</AssistantMarkdown>)
      })
      const blocks = renderer!.root.findAllByType('Markdown' as never)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]!.props.markdown).toBe(content)
    }
  })

  it('reports a clipboard failure through the existing native error boundary', async () => {
    const markdown = await render()
    const failure = new Error('Clipboard unavailable')
    vi.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(failure)
    await act(() => markdown.props.contextMenuItems[0].onPress())
    expect(showErrorAlert).toHaveBeenCalledWith(failure, { title: '无法复制消息' })
  })

  it('batches rapid streaming tails without rerendering completed sections or delaying completion', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16)
    )
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
    const prefix = `# First\n${'Paragraph text. '.repeat(300)}\n`
    let content = `${prefix}## Second\nTail`
    await act(() => {
      renderer = create(<AssistantMarkdown streaming>{content}</AssistantMarkdown>)
    })
    nativeRender.mockClear()
    for (let index = 0; index < 20; index++) {
      content += ` ${index}`
      await act(() => renderer!.update(<AssistantMarkdown streaming>{content}</AssistantMarkdown>))
      await act(() => {
        vi.advanceTimersByTime(10)
      })
    }
    expect(nativeRender.mock.calls.length).toBeGreaterThan(0)
    expect(nativeRender.mock.calls.length).toBeLessThan(4)
    expect(nativeRender.mock.calls.every(([props]) => props.markdown.startsWith('## Second'))).toBe(
      true
    )
    await act(() => renderer!.update(<AssistantMarkdown>{content}</AssistantMarkdown>))
    const blocks = renderer!.root.findAllByType('Markdown' as never)
    expect(blocks.map(block => block.props.markdown).join('')).toBe(content)
    expect(blocks.at(-1)!.props.streamingAnimation).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
