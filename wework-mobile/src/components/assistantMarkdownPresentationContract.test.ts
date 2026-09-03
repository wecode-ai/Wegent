import { describe, expect, it } from 'vitest'

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { eager: true; import: 'default'; query: '?raw' }
    ): Record<string, string>
  }
}

const sources = import.meta.glob(['./AssistantMarkdown.tsx', './MessageList.tsx'], {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

describe('assistant markdown presentation contract', () => {
  it('uses the native GFM renderer for text, lists, inline code, and code blocks', () => {
    const markdown = sources['./AssistantMarkdown.tsx']

    expect(markdown).toContain('EnrichedMarkdownText')
    expect(markdown).toContain('flavor="github"')
    expect(markdown).toContain('enableTaskListItemToggle={false}')
    expect(markdown).toContain('streamingAnimation={streaming}')
    expect(markdown).toContain('codeBlock: {')
    expect(markdown).toContain('itemSpacing: muted ? 2 : 6')
    expect(markdown).not.toContain('react-native-markdown-display')
  })

  it('enables progressive rendering while an assistant message streams', () => {
    const messages = sources['./MessageList.tsx']

    expect(messages).toContain("<AssistantMarkdown streaming={message.status === 'streaming'}>")
  })
})
