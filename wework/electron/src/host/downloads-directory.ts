import { join } from 'node:path'

type ElectronPathName = 'downloads' | 'home'

export function resolveDownloadsDirectory(
  getPath: (name: ElectronPathName) => string,
  onKnownFolderFailure?: (error: unknown, fallbackPath: string) => void
): string {
  try {
    return getPath('downloads')
  } catch (error) {
    const fallbackPath = join(getPath('home'), 'Downloads')
    onKnownFolderFailure?.(error, fallbackPath)
    return fallbackPath
  }
}
