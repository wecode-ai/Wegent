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

export function latestResponseLine(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? null
}

export function finalAssistantMessagesPreview(
  messages: readonly RuntimeResponseMessage[]
): string | null {
  const response = finalAssistantMessagesText(messages)
  return response ? latestResponseLine(response) : null
}

export function finalAssistantMessagesText(
  messages: readonly RuntimeResponseMessage[]
): string | null {
  for (const message of [...messages].reverse()) {
    if (!message.role?.toLowerCase().startsWith('assistant')) continue
    const content = messageText(message)
    if (content) return content
  }
  return null
}

export function latestAssistantMessage<T extends RuntimeResponseMessage>(
  messages: readonly T[]
): T | null {
  for (const message of [...messages].reverse()) {
    if (!message.role?.toLowerCase().startsWith('assistant')) continue
    if (messageText(message) || message.blocks?.length) return message
  }
  return null
}

export function finalAssistantTranscriptMessage<T extends RuntimeResponseMessage>(transcript: {
  messages: readonly T[]
}): T | null {
  return latestAssistantMessage(transcript.messages)
}

export function finalAssistantTranscriptPreview(transcript: {
  messages: readonly RuntimeResponseMessage[]
  turns: readonly RuntimeResponseTurn[]
}): string | null {
  const response = finalAssistantTranscriptText(transcript)
  return response ? latestResponseLine(response) : null
}

export function finalAssistantTranscriptText(transcript: {
  messages: readonly RuntimeResponseMessage[]
  turns: readonly RuntimeResponseTurn[]
}): string | null {
  const latestTurn = transcript.turns.at(-1)
  if (!latestTurn) return finalAssistantMessagesText(transcript.messages)

  const content = latestTurn.items
    .flatMap(item =>
      item.type === 'assistant_text' && typeof item.content === 'string' ? [item.content] : []
    )
    .join('\n')
    .trim()
  return content || null
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
