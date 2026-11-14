/** Match native text previews without decoding a trailing partial UTF-8 character. */
export async function readSourcePreview(file: Blob): Promise<{ text: string; truncated: boolean }> {
  const limit = 256 * 1024
  const truncated = file.size > limit
  const bytes = await file.slice(0, limit).arrayBuffer()
  return { text: new TextDecoder().decode(bytes, { stream: truncated }), truncated }
}
