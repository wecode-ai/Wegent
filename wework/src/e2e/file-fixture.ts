import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'

export function createDesktopControlFile(
  command: Pick<DesktopControlCommand, 'filename' | 'fileSize' | 'mimeType' | 'value'>
): File {
  const filename = command.filename?.trim()
  if (!filename) throw new Error('File fixture requires a filename')
  const bytes = Uint8Array.from(atob(command.value ?? ''), character => character.charCodeAt(0))
  const size = command.fileSize ?? bytes.byteLength
  if (!Number.isSafeInteger(size) || size < bytes.byteLength) {
    throw new Error('File fixture size must be a safe integer at least as large as its content')
  }
  const parts: BlobPart[] = [bytes]
  let remaining = size - bytes.byteLength
  const padding = new Blob([new Uint8Array(Math.min(remaining, 1024 * 1024))])
  while (remaining > 0) {
    const chunkSize = Math.min(remaining, padding.size)
    parts.push(padding.slice(0, chunkSize))
    remaining -= chunkSize
  }
  return new File(parts, filename, { type: command.mimeType ?? '' })
}
