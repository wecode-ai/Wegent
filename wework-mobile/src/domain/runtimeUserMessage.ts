const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im

export interface RuntimeUserMessageParts {
  prefix: string
  request: string
}

export function splitRuntimeUserMessage(content: string): RuntimeUserMessageParts | null {
  const requestMarker = content.match(CODEX_REQUEST_MARKER_PATTERN)
  if (requestMarker?.index === undefined) return null

  return {
    prefix: content.slice(0, requestMarker.index),
    request: content.slice(requestMarker.index + requestMarker[0].length).trim(),
  }
}

export function visibleRuntimeUserMessage(content: string): string {
  const parts = splitRuntimeUserMessage(content)
  return parts?.request ?? content.trim()
}
