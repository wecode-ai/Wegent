const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im
const APPLICATION_CONTEXT_OPEN = '<application_context>'
const APPLICATION_CONTEXT_CLOSE = '</application_context>'

export interface RuntimeUserMessageParts {
  prefix: string
  request: string
}

export function splitRuntimeUserMessage(content: string): RuntimeUserMessageParts | null {
  const requestMarker = content.match(CODEX_REQUEST_MARKER_PATTERN)
  if (requestMarker?.index === undefined) return null

  return {
    prefix: content.slice(0, requestMarker.index),
    request: stripLeadingApplicationContext(
      content.slice(requestMarker.index + requestMarker[0].length)
    ),
  }
}

export function visibleRuntimeUserMessage(content: string): string {
  const parts = splitRuntimeUserMessage(content)
  return parts?.request ?? stripLeadingApplicationContext(content)
}

function stripLeadingApplicationContext(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith(APPLICATION_CONTEXT_OPEN)) return trimmed.trim()

  const closeIndex = matchingApplicationContextCloseIndex(trimmed)
  if (closeIndex < 0) return trimmed.trim()

  return trimmed.slice(closeIndex + APPLICATION_CONTEXT_CLOSE.length).trim()
}

function matchingApplicationContextCloseIndex(content: string): number {
  let depth = 1
  let offset = APPLICATION_CONTEXT_OPEN.length

  while (offset < content.length) {
    const nextOpen = content.indexOf(APPLICATION_CONTEXT_OPEN, offset)
    const nextClose = content.indexOf(APPLICATION_CONTEXT_CLOSE, offset)
    if (nextClose < 0) return -1

    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1
      offset = nextOpen + APPLICATION_CONTEXT_OPEN.length
      continue
    }

    depth -= 1
    if (depth === 0) return nextClose
    offset = nextClose + APPLICATION_CONTEXT_CLOSE.length
  }

  return -1
}
