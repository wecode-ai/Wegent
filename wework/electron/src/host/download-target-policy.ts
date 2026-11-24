import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { access, mkdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, parse } from 'node:path'

export interface DownloadPreferences {
  downloadDirectory: string | null
  askBeforeDownload: boolean
}

export type SaveDialogReason = 'ask-before-download' | 'save-as' | 'directory-unavailable'

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
  once?: (event: 'destroyed', listener: () => void) => unknown
}

interface DownloadFileSystem {
  access: (path: string, mode?: number) => Promise<void>
  accessSync: (path: string, mode?: number) => void
  existsSync: (path: string) => boolean
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
  stat: (path: string) => Promise<{ isDirectory: () => boolean }>
  statSync: (path: string) => { isDirectory: () => boolean }
}

export interface DownloadTargetPolicyOptions {
  defaultDownloadsDirectory: () => string
  onDownloadCompleted?: (savePath: string) => void
  onDirectoryWarning?: (message: string, error: unknown) => void
  fs?: DownloadFileSystem
  caseInsensitivePaths?: boolean
}

const MAX_PENDING_SAVE_AS_PER_TARGET = 64

const DEFAULT_FS: DownloadFileSystem = {
  access,
  accessSync,
  existsSync,
  mkdir,
  stat,
  statSync,
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

function reservationKey(targetPath: string, caseInsensitive: boolean): string {
  return caseInsensitive ? targetPath.toLowerCase() : targetPath
}

function findAvailablePath(
  directory: string,
  filename: string,
  activeSavePaths: ReadonlySet<string>,
  exists: (path: string) => boolean,
  caseInsensitive: boolean
): string {
  const parsed = parse(filename)
  for (let index = 0; ; index += 1) {
    const candidateName = index === 0 ? filename : `${parsed.name} (${index})${parsed.ext}`
    const candidatePath = join(directory, candidateName)
    const key = reservationKey(candidatePath, caseInsensitive)
    if (!exists(candidatePath) && !activeSavePaths.has(key)) {
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
  private readonly verifiedDirectories = new Map<string, boolean>()
  private readonly pendingSaveAs = new Map<number, string[]>()
  private readonly observedDestroyTargets = new Set<number>()
  private readonly fs: DownloadFileSystem
  private readonly caseInsensitivePaths: boolean
  private prepareGeneration = 0
  private preparing = false

  constructor(private readonly options: DownloadTargetPolicyOptions) {
    this.fs = options.fs ?? DEFAULT_FS
    this.caseInsensitivePaths =
      options.caseInsensitivePaths ??
      (process.platform === 'darwin' || process.platform === 'win32')
  }

  update(preferences: Record<string, unknown>): Promise<void> {
    this.preferences = resolveDownloadPreferences(preferences)
    return this.prepare({ createMissing: true })
  }

  async prepare(options: { createMissing?: boolean } = {}): Promise<void> {
    const createMissing = options.createMissing ?? true
    const generation = ++this.prepareGeneration
    this.preparing = true
    try {
      const target = this.configuredTargetDirectory()
      if (!target) {
        if (generation === this.prepareGeneration) this.verifiedDirectories.clear()
        return
      }
      const writable = createMissing
        ? await this.tryPrepareDirectory(target.directory, target.label)
        : await this.tryCheckExistingDirectory(target.directory, target.label)
      if (generation !== this.prepareGeneration) return
      this.verifiedDirectories.clear()
      this.verifiedDirectories.set(target.directory, writable)
    } finally {
      if (generation === this.prepareGeneration) {
        this.preparing = false
      }
    }
  }

  current(): DownloadPreferences {
    return { ...this.preferences }
  }

  downloadUrlAs(contents: DownloadUrlTarget, url: string): void {
    const normalizedUrl = normalizeMatchUrl(url)
    const entries = this.pendingSaveAs.get(contents.id) ?? []
    entries.push(normalizedUrl)
    if (entries.length > MAX_PENDING_SAVE_AS_PER_TARGET) {
      entries.splice(0, entries.length - MAX_PENDING_SAVE_AS_PER_TARGET)
    }
    this.pendingSaveAs.set(contents.id, entries)
    if (!this.observedDestroyTargets.has(contents.id) && contents.once) {
      this.observedDestroyTargets.add(contents.id)
      contents.once('destroyed', () => {
        this.pendingSaveAs.delete(contents.id)
        this.observedDestroyTargets.delete(contents.id)
      })
    }
    contents.downloadURL(url)
  }

  apply(
    item: ManagedDownloadItem,
    webContents?: { id: number } | null
  ): { mode: 'save-path' | 'save-dialog'; path: string; reason?: SaveDialogReason } {
    const webContentsId = webContents?.id ?? null
    const promptForSave = this.consumePendingSaveAs(webContentsId, item)
    const filename = sanitizeDownloadFilename(item.getFilename())
    const selection = this.selectVerifiedDirectory()

    if (!selection.directory) {
      if (!this.preparing) {
        // Re-verify existing directory status asynchronously without recreating a deleted directory.
        void this.prepare({ createMissing: selection.status === 'pending' })
      }
      const defaultPath = this.fallbackDefaultPath(filename)
      const reason: SaveDialogReason = promptForSave
        ? 'save-as'
        : this.preferences.askBeforeDownload
          ? 'ask-before-download'
          : 'directory-unavailable'
      return this.requestSaveDialog(item, defaultPath, reason)
    }

    const candidatePath = findAvailablePath(
      selection.directory,
      filename,
      this.activeSavePaths,
      this.fs.existsSync,
      this.caseInsensitivePaths
    )

    if (promptForSave || this.preferences.askBeforeDownload) {
      const reason: SaveDialogReason = promptForSave ? 'save-as' : 'ask-before-download'
      return this.requestSaveDialog(item, candidatePath, reason)
    }

    const reservedKey = reservationKey(candidatePath, this.caseInsensitivePaths)
    this.activeSavePaths.add(reservedKey)
    item.setSavePath(candidatePath)
    item.once('done', (_event, state) => {
      this.activeSavePaths.delete(reservedKey)
      if (state === 'completed') this.notifyCompleted(item, candidatePath)
    })
    return { mode: 'save-path', path: candidatePath }
  }

  private requestSaveDialog(
    item: ManagedDownloadItem,
    defaultPath: string,
    reason: SaveDialogReason
  ): { mode: 'save-dialog'; path: string; reason: SaveDialogReason } {
    item.setSaveDialogOptions({ defaultPath })
    this.attachCompletionHook(item)
    return { mode: 'save-dialog', path: defaultPath, reason }
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

  private configuredTargetDirectory(): { directory: string; label: string } | null {
    const preferred = this.preferences.downloadDirectory
    if (preferred !== null) {
      if (!isAbsolute(preferred)) return null
      return { directory: preferred, label: 'custom download directory' }
    }
    const fallback = this.resolveFallbackDirectory()
    if (!fallback) return null
    return { directory: fallback, label: 'system downloads directory' }
  }

  private selectVerifiedDirectory(): {
    directory: string | null
    status: 'ready' | 'pending' | 'unavailable'
  } {
    const target = this.configuredTargetDirectory()
    if (!target) return { directory: null, status: 'unavailable' }
    const cached = this.verifiedDirectories.get(target.directory)
    if (cached === undefined) return { directory: null, status: 'pending' }
    if (cached === false) return { directory: null, status: 'unavailable' }
    if (!this.isDirectoryWritableNow(target.directory, target.label)) {
      this.verifiedDirectories.set(target.directory, false)
      return { directory: null, status: 'unavailable' }
    }
    return { directory: target.directory, status: 'ready' }
  }

  private isDirectoryWritableNow(directory: string, label: string): boolean {
    try {
      if (!this.fs.statSync(directory).isDirectory()) {
        this.options.onDirectoryWarning?.(
          `[downloads] ${label} is no longer a directory (${directory}); prompting save dialog`,
          new Error('Target path is not a directory')
        )
        return false
      }
      this.fs.accessSync(directory, fsConstants.W_OK)
      return true
    } catch (error) {
      this.options.onDirectoryWarning?.(
        `[downloads] ${label} is no longer writable (${directory}); prompting save dialog`,
        error
      )
      return false
    }
  }

  private resolveFallbackDirectory(): string | null {
    try {
      const fallback = this.options.defaultDownloadsDirectory()
      return fallback && isAbsolute(fallback) ? fallback : null
    } catch (error) {
      this.options.onDirectoryWarning?.(
        '[downloads] failed to resolve system downloads directory; falling back to save dialog',
        error
      )
      return null
    }
  }

  private async tryPrepareDirectory(directory: string, label: string): Promise<boolean> {
    try {
      await this.fs.mkdir(directory, { recursive: true })
      const info = await this.fs.stat(directory)
      if (!info.isDirectory()) throw new Error('Target path is not a directory')
      await this.fs.access(directory, fsConstants.W_OK)
      return true
    } catch (error) {
      this.options.onDirectoryWarning?.(
        `[downloads] ${label} is unavailable (${directory}); prompting save dialog`,
        error
      )
      return false
    }
  }

  private async tryCheckExistingDirectory(directory: string, label: string): Promise<boolean> {
    try {
      const info = await this.fs.stat(directory)
      if (!info.isDirectory()) return false
      await this.fs.access(directory, fsConstants.W_OK)
      return true
    } catch (error) {
      this.options.onDirectoryWarning?.(
        `[downloads] ${label} remains unavailable (${directory}); prompting save dialog`,
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

  private consumePendingSaveAs(webContentsId: number | null, item: ManagedDownloadItem): boolean {
    if (webContentsId === null) return false
    const entries = this.pendingSaveAs.get(webContentsId)
    if (!entries || entries.length === 0) return false
    const candidateUrls = new Set<string>()
    for (const url of item.getURLChain?.() ?? []) {
      candidateUrls.add(normalizeMatchUrl(url))
    }
    candidateUrls.add(normalizeMatchUrl(item.getURL()))

    const matchIndex = entries.findIndex(url => candidateUrls.has(url))
    if (matchIndex === -1) return false
    entries.splice(matchIndex, 1)
    if (entries.length === 0) this.pendingSaveAs.delete(webContentsId)
    return true
  }
}
