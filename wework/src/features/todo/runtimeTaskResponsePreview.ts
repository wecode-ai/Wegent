interface RuntimeResponseBlock {
  type?: string | null
  content?: unknown
}

interface RuntimeResponseMessage {
  role?: string | null
  content?: string | null
  blocks?: readonly RuntimeResponseBlock[] | null
}

interface RuntimeResponseTurn {
  items: readonly {
    type: string
    content?: unknown
  }[]
}

export function firstThreeResponseLines(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3)
  return lines.length > 0 ? lines.join('\n') : null
}

export function finalAssistantMessagesPreview(
  messages: readonly RuntimeResponseMessage[]
): string | null {
  for (const message of [...messages].reverse()) {
    if (!message.role?.toLowerCase().startsWith('assistant')) continue
    const preview = firstThreeResponseLines(messageText(message))
    if (preview) return preview
  }
  return null
}

export function finalAssistantTranscriptPreview(transcript: {
  messages: readonly RuntimeResponseMessage[]
  turns: readonly RuntimeResponseTurn[]
}): string | null {
  const messagePreview = finalAssistantMessagesPreview(transcript.messages)
  if (messagePreview) return messagePreview

  for (const turn of [...transcript.turns].reverse()) {
    const content = turn.items
      .flatMap(item =>
        item.type === 'assistant_text' && typeof item.content === 'string' ? [item.content] : []
      )
      .join('\n')
    const turnPreview = firstThreeResponseLines(content)
    if (turnPreview) return turnPreview
  }
  return null
}

function messageText(message: RuntimeResponseMessage): string {
  if (message.content?.trim()) return message.content.trim()
  return (message.blocks ?? [])
    .flatMap(block =>
      block.type === 'text' && typeof block.content === 'string' ? [block.content] : []
    )
    .join('\n')
    .trim()
}
