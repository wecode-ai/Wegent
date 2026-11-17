export type ClaudeCapturedMessage = {
  role: string
  content: unknown
}

const TOOL_FALLBACK_NOTICE =
  'ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.'

export function withClaudeToolFallback(messages: ClaudeCapturedMessage[]): ClaudeCapturedMessage[] {
  const tail = messages.at(-1)
  const previous = tail?.role === 'system' ? tail : undefined
  const content = previous?.content
  if (
    previous &&
    (!Array.isArray(content) ||
      content.length !== 1 ||
      content[0]?.type !== 'text' ||
      typeof content[0].text !== 'string')
  ) {
    throw new Error('Unexpected Claude Code trailing system message structure')
  }
  const block = previous ? (content as Array<{ text: string }>)[0] : undefined
  return [
    ...(previous ? messages.slice(0, -1) : messages),
    {
      role: 'system',
      content: [
        block
          ? { ...block, text: `${block.text}\n\n${TOOL_FALLBACK_NOTICE}` }
          : {
              type: 'text',
              text: TOOL_FALLBACK_NOTICE,
              cache_control: { type: 'ephemeral' },
            },
      ],
    },
  ]
}
