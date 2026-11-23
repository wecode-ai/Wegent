import { accessSync, constants as fsConstants, existsSync, mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, parse } from 'node:path'

export interface DownloadPreferences {
  downloadDirectory: string | null
  askBeforeDownload: boolean
}

export interface ManagedDownloadItem {
  getFilename: () => string
  getSavePath: () => string
  getURL: () => string
  getURLChain?: () => string[]
  setSavePath: (path: string) => void
  setSaveDialogOptions: (options: { defaultPath?: string }) => void
  once: (event: 'done', listener: (event: unknown, state: string) => void) => unknown
}

export interface DownloadUrlTarget {
  id: number
  downloadURL: (url: string) => void
}

interface DownloadFileSystem {
  accessSync: (path: string, mode?: number) => void
  existsSync: (path: string) => boolean
  mkdirSync: (path: string, options: { recursive: true }) => unknown
}

export interface DownloadTargetPolicyOptions {
  defaultDownloadsDirectory: () => string
  onDownloadCompleted?: (savePath: string) => void
  onDirectoryWarning?: (message: string, error: unknown) => void
  fs?: DownloadFileSystem
  now?: () => number
  saveAsTtlMs?: number
}

interface PendingSaveAsEntry {
  url: string
  expiresAt: number
}

const DEFAULT_SAVE_AS_TTL_MS = 60_000

const DEFAULT_FS: DownloadFileSystem = {
  accessSync,
  existsSync,
  mkdirSync,
}

export function resolveDownloadPreferences(
  preferences: Record<string, unknown>
): DownloadPreferences {
  const rawDirectory = preferences.browserDownloadDirectory
  return {
    downloadDirectory:
      typeof rawDirectory === 'string' && rawDirectory.trim() ? rawDirectory.trim() : null,
    askBeforeDownload: preferences.browserAskBeforeDownload === true,
  }
}

export function sanitizeDownloadFilename(rawFilename: string): string {
  const normalized = rawFilename.trim().replaceAll('\\', '/')
  const base = Array.from(basename(normalized))
    .filter(character => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .trim()
  if (!base || base === '.' || base === '..') return 'download'
  return base
}

function normalizeMatchUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.hash = ''
    return parsed.href
  } catch {
    return rawUrl.split('#', 1)[0] ?? rawUrl
  }
}

function findAvailablePath(
  directory: string,
  filename: string,
  activeSavePaths: ReadonlySet<string>,
  exists: (path: string) => boolean
): string {
  const parsed = parse(filename)
  for (let index = 0; ; index += 1) {
    const candidateName = index === 0 ? filename : `${parsed.name} (${index})${parsed.ext}`
    const candidatePath = join(directory, candidateName)
    if (!exists(candidatePath) && !activeSavePaths.has(candidatePath)) {
      return candidatePath
    }
  }
}

export class DownloadTargetPolicy {
  private preferences: DownloadPreferences = {
    downloadDirectory: null,
    askBeforeDownload: false,
  }
  private readonly activeSavePaths = new Set<string>()
  private readonly pendingSaveAs = new Map<number, PendingSaveAsEntry[]>()
  private readonly fs: DownloadFileSystem
  private readonly now: () => number
  private readonly saveAsTtlMs: number

  constructor(private readonly options: DownloadTargetPolicyOptions) {
    this.fs = options.fs ?? DEFAULT_FS
    this.now = options.now ?? Date.now
    this.saveAsTtlMs = options.saveAsTtlMs ?? DEFAULT_SAVE_AS_TTL_MS
  }

  update(preferences: Record<string, unknown>): void {
    this.preferences = resolveDownloadPreferences(preferences)
  }

  current(): DownloadPreferences {
    return { ...this.preferences }
  }

  downloadUrlAs(contents: DownloadUrlTarget, url: string): void {
    const now = this.now()
    const normalizedUrl = normalizeMatchUrl(url)
    const entries = this.prunePendingSaveAs(contents.id, now)
    entries.push({ url: normalizedUrl, expiresAt: now + this.saveAsTtlMs })
    this.pendingSaveAs.set(contents.id, entries)
    contents.downloadURL(url)
  }

  apply(
    item: ManagedDownloadItem,
    webContents?: { id: number } | null
  ): { mode: 'save-path' | 'save-dialog'; path: string } {
    const promptForSave = this.consumePendingSaveAs(webContents?.id ?? null, item)
    const filename = sanitizeDownloadFilename(item.getFilename())
    const directory = this.prepareWritableDirectory()

    if (!directory) {
      const defaultPath = this.fallbackDefaultPath(filename)
      item.setSaveDialogOptions({ defaultPath })
      this.attachCompletionHook(item)
      return { mode: 'save-dialog', path: defaultPath }
    }

    const candidatePath = findAvailablePath(
      directory,
      filename,
      this.activeSavePaths,
      this.fs.existsSync
    )

    if (promptForSave || this.preferences.askBeforeDownload) {
      item.setSaveDialogOptions({ defaultPath: candidatePath })
      this.attachCompletionHook(item)
      return { mode: 'save-dialog', path: candidatePath }
    }

    this.activeSavePaths.add(candidatePath)
    item.setSavePath(candidatePath)
    item.once('done', (_event, state) => {
      this.activeSavePaths.delete(candidatePath)
      if (state === 'completed') this.notifyCompleted(item, candidatePath)
    })
    return { mode: 'save-path', path: candidatePath }
  }

  private attachCompletionHook(item: ManagedDownloadItem): void {
    if (!this.options.onDownloadCompleted) return
    item.once('done', (_event, state) => {
      if (state === 'completed') this.notifyCompleted(item)
    })
  }

  private notifyCompleted(item: ManagedDownloadItem, fallbackPath?: string): void {
    const savePath = item.getSavePath() || fallbackPath
    if (savePath) this.options.onDownloadCompleted?.(savePath)
  }

  private prepareWritableDirectory(): string | null {
    const preferred = this.preferences.downloadDirectory
    if (preferred && isAbsolute(preferred)) {
      if (this.tryPrepareDirectory(preferred, 'custom download directory')) {
        return preferred
      }
    }
    try {
      const fallback = this.options.defaultDownloadsDirectory()
      if (fallback && this.tryPrepareDirectory(fallback, 'system downloads directory')) {
        return fallback
      }
    } catch (error) {
      this.options.onDirectoryWarning?.(
        '[downloads] failed to resolve system downloads directory; falling back to save dialog',
        error
      )
    }
    return null
  }

  private tryPrepareDirectory(directory: string, label: string): boolean {
    try {
      this.fs.mkdirSync(directory, { recursive: true })
      this.fs.accessSync(directory, fsConstants.W_OK)
      return true
    } catch (error) {
      this.options.onDirectoryWarning?.(
        `[downloads] ${label} is unavailable (${directory}); falling back`,
        error
      )
      return false
    }
  }

  private fallbackDefaultPath(filename: string): string {
    try {
      const fallback = this.options.defaultDownloadsDirectory()
      return fallback ? join(fallback, filename) : filename
    } catch {
      return filename
    }
  }

  private prunePendingSaveAs(webContentsId: number, now: number): PendingSaveAsEntry[] {
    const entries = this.pendingSaveAs.get(webContentsId)
    if (!entries || entries.length === 0) return []
    const active = entries.filter(entry => entry.expiresAt >= now)
    if (active.length === 0) this.pendingSaveAs.delete(webContentsId)
    else this.pendingSaveAs.set(webContentsId, active)
    return active
  }

  private consumePendingSaveAs(webContentsId: number | null, item: ManagedDownloadItem): boolean {
    if (webContentsId === null) return false
    const entries = this.prunePendingSaveAs(webContentsId, this.now())
    if (entries.length === 0) return false
    const candidateUrls = new Set<string>()
    for (const url of item.getURLChain?.() ?? []) {
      candidateUrls.add(normalizeMatchUrl(url))
    }
    candidateUrls.add(normalizeMatchUrl(item.getURL()))

    const matchIndex = entries.findIndex(entry => candidateUrls.has(entry.url))
    if (matchIndex === -1) return false
    entries.splice(matchIndex, 1)
    if (entries.length === 0) this.pendingSaveAs.delete(webContentsId)
    return true
  }
}
