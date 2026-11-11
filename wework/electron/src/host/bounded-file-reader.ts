import type { FileHandle } from 'node:fs/promises'

/** Bounds actual bytes read, even when a file grows after its metadata was read. */
export async function readBoundedFile(
  file: Pick<FileHandle, 'read'>,
  maximumBytes: number,
  afterRead: () => void | Promise<void> = () => {}
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maximumBytes - total + 1))
    const { bytesRead } = await file.read(chunk, 0, chunk.length, total)
    await afterRead()
    if (!bytesRead) return Buffer.concat(chunks, total)
    total += bytesRead
    if (total > maximumBytes) throw new Error('File exceeds the allowed size')
    chunks.push(chunk.subarray(0, bytesRead))
  }
}
