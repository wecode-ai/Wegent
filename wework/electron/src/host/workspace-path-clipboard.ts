import { clipboard } from 'electron'
import {
  extractFilePathsFromNativePayloads,
  inspectWorkspacePaths,
  type InspectedWorkspacePath,
} from './workspace-path-inspector.js'

export async function readClipboardWorkspacePaths(
  fallbackPaths: readonly string[]
): Promise<InspectedWorkspacePath[]> {
  let formats: string[] = []
  try {
    formats = clipboard.availableFormats()
  } catch {
    // Renderer paste payloads remain usable when the native clipboard is unavailable.
  }
  const payloads = formats
    .filter(format => /(file|filename|uri)/i.test(format))
    .flatMap(readNativePayloads)
  return inspectWorkspacePaths([...extractFilePathsFromNativePayloads(payloads), ...fallbackPaths])
}

function readNativePayloads(format: string): string[] {
  const encoding = format.toLowerCase() === 'filenamew' ? 'utf16le' : 'utf8'
  try {
    const buffer = clipboard.readBuffer(format)
    return buffer.length > 0 ? [buffer.toString(encoding)] : []
  } catch {
    // A native format can disappear between enumeration and reading.
    return []
  }
}
