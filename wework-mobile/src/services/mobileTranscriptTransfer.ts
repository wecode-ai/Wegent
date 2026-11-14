import { gunzipSync, strFromU8 } from 'fflate'

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

/** Native adapter for the shared PC transcript transfer; fflate does not verify gzip trailers. */
export async function decodeMobileTranscriptGzip(chunks: Uint8Array[]): Promise<string> {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (bytes.length < 18) throw new Error('Invalid gzip transcript')
  const content = gunzipSync(bytes)
  const trailer = new DataView(bytes.buffer, bytes.byteLength - 8)
  let crc = 0xffffffff
  for (const byte of content) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  if (
    trailer.getUint32(0, true) !== (crc ^ 0xffffffff) >>> 0 ||
    trailer.getUint32(4, true) !== content.length >>> 0
  )
    throw new Error('Corrupted gzip transcript')
  return strFromU8(content)
}
