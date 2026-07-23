const STATIC_MARKDOWN_WINDOW_THRESHOLD = 8_000
const STATIC_MARKDOWN_CHUNK_TARGET = 1_200

export function splitStaticMarkdownChunks(content: string): string[] {
  if (content.length < STATIC_MARKDOWN_WINDOW_THRESHOLD) return [content]

  const chunks: string[] = []
  let current = ''
  let fenceMarker: '`' | '~' | null = null
  for (const line of content.match(/.*(?:\n|$)/g) ?? []) {
    if (!fenceMarker && /^#{1,3}\s/.test(line) && current.length >= STATIC_MARKDOWN_CHUNK_TARGET) {
      chunks.push(current)
      current = ''
    }
    current += line
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (!fence) continue
    const marker = fence[1]?.[0]
    if (marker !== '`' && marker !== '~') continue
    fenceMarker = fenceMarker === null ? marker : fenceMarker === marker ? null : fenceMarker
  }
  if (current) chunks.push(current)
  return chunks.length > 1 ? chunks : [content]
}
