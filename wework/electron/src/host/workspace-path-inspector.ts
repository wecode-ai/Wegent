import { stat } from 'node:fs/promises'

export interface InspectedWorkspacePath {
  path: string
  isDirectory: boolean
}

export async function inspectWorkspacePaths(
  paths: readonly string[]
): Promise<InspectedWorkspacePath[]> {
  const inspected: InspectedWorkspacePath[] = []
  const seen = new Set<string>()

  for (const rawPath of paths) {
    const path = rawPath.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    try {
      const metadata = await stat(path)
      inspected.push({ path, isDirectory: metadata.isDirectory() })
    } catch {
      // Native clipboard and drag payloads may contain stale paths.
    }
  }
  return inspected
}

export function extractFilePathsFromNativePayloads(payloads: readonly string[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>()

  const append = (candidate: string) => {
    const value = candidate.trim()
    const path = fileUrlToPath(value) ?? absolutePath(value)
    if (!path || seen.has(path)) return
    seen.add(path)
    paths.push(path)
  }

  for (const payload of payloads) {
    const normalized = payload.replaceAll('\0', '\n')
    const nativeStrings = /<string>(.*?)<\/string>/gis
    for (const match of normalized.matchAll(nativeStrings)) {
      append(decodeXml(match[1] ?? ''))
    }
    const plainPayload = normalized.replace(nativeStrings, '')
    for (const match of plainPayload.matchAll(/file:\/\/[^\s<>"']+/gi)) {
      append(match[0])
    }
    for (const line of plainPayload.split(/\r?\n/)) {
      append(line)
    }
  }
  return paths
}

function fileUrlToPath(value: string): string | null {
  if (!value.toLocaleLowerCase().startsWith('file://')) return null
  try {
    const url = new URL(value)
    const pathname = decodeURIComponent(url.pathname)
    if (url.hostname) {
      return `//${url.hostname}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
    }
    return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return null
  }
}

function absolutePath(value: string): string | null {
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return value
  return null
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}
