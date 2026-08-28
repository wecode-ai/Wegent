export async function sha256Hex(blob: Blob): Promise<string> {
  const source = new Uint8Array(await blob.arrayBuffer())
  const bytes = new Uint8Array(source.byteLength)
  bytes.set(source)

  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
