const CONTENT_CHUNK_SIZE = 128 * 1024

export function splitContentChunks(content: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < content.length; ) {
    let end = Math.min(offset + CONTENT_CHUNK_SIZE, content.length)
    const finalUnit = content.charCodeAt(end - 1)
    if (end < content.length && finalUnit >= 0xd800 && finalUnit <= 0xdbff) end -= 1
    chunks.push(content.slice(offset, end))
    offset = end
  }
  return chunks
}
