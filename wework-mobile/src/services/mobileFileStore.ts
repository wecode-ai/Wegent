import type { WorkspaceFileChunkResponse } from '../../../packages/chat-core/src/workspace-files'
import {
  isLikelyTextContent,
  mimeTypeForFileName,
  workspaceFilePreviewKind,
} from '../../../packages/chat-core/src/workspace-file-types'
import { resolveWorkspaceFilePath } from '../../../packages/chat-core/src/workspace-file-paths'
import { mobileFileKey, mobileFileName } from '@/domain/mobileFiles'
import type { LoadedMobileFile, MobileFileRequest } from '@/types/files'
import type { RuntimeApi } from './runtimeApi'

export interface FileLoadOptions {
  signal: AbortSignal
  complete?: boolean
  onProgress?: (loaded: number, total: number) => void
}

const TEXT_PREVIEW_BYTES = 256 * 1024
const CACHE_FILE_COUNT = 30
const CACHE_TARGET_BYTES = 256 * 1024 * 1024

interface CachedMobileFile {
  preview?: NativeFileRead
  complete?: NativeFileRead
}

interface NativeFileRead {
  document: LoadedMobileFile
  complete: boolean
  directory: import('expo-file-system').Directory
  cached: boolean
  leases: number
  bytes: number
}

export interface MobileFileLease {
  document: LoadedMobileFile
  release: () => void
}

type FileReadResult = Pick<NativeFileRead, 'document' | 'complete'>

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error('文件读取已取消')
}

/** Streams verified chunks to the native file handle without buffering a whole file in JS. */
export async function copyWorkspaceFileChunks(
  read: (offset: number) => Promise<WorkspaceFileChunkResponse>,
  write: (bytes: Uint8Array) => void,
  options: FileLoadOptions
): Promise<number> {
  let offset = 0
  let total: number | undefined
  while (true) {
    throwIfAborted(options.signal)
    const chunk = await read(offset)
    throwIfAborted(options.signal)
    if (
      !Number.isSafeInteger(chunk.size) ||
      chunk.size < 0 ||
      chunk.offset !== offset ||
      typeof chunk.eof !== 'boolean' ||
      typeof chunk.contentBase64 !== 'string' ||
      (total !== undefined && total !== chunk.size)
    )
      throw new Error('设备返回了无效的文件分片')
    total = chunk.size
    const decoded = atob(chunk.contentBase64)
    const bytes = Uint8Array.from(decoded, value => value.charCodeAt(0))
    if (offset + bytes.length > total || (!bytes.length && !chunk.eof))
      throw new Error('设备返回了无效的文件分片长度')
    write(bytes)
    offset += bytes.length
    options.onProgress?.(offset, total)
    if (chunk.eof) {
      if (offset !== total) throw new Error('文件下载未完成')
      return total
    }
    if (offset >= total) throw new Error('文件分片缺少结束标记')
  }
}

export class MobileFileStore {
  private readonly cache = new Map<string, CachedMobileFile>()
  private readonly files = new Set<NativeFileRead>()
  private readonly pending = new Map<string, Set<AbortController>>()
  private directory: import('expo-file-system').Directory | null = null
  private disposed = false

  constructor(private readonly api: RuntimeApi) {}

  async acquire(request: MobileFileRequest, options: FileLoadOptions): Promise<MobileFileLease> {
    const file = await this.loadNative(request, options)
    try {
      this.assertActive(options.signal)
    } catch (error) {
      this.releaseFile(file)
      throw error
    }
    let released = false
    return {
      document: this.withLineTarget(file.document, request, options.complete),
      release: () => {
        if (released) return
        released = true
        this.releaseFile(file)
      },
    }
  }

  private async loadNative(
    request: MobileFileRequest,
    options: FileLoadOptions
  ): Promise<NativeFileRead> {
    this.assertActive(options.signal)
    const key = mobileFileKey(request)
    const entry = this.cache.get(key)
    const cached = options.complete ? entry?.complete : entry?.preview
    if (cached) {
      cached.leases += 1
      this.cache.delete(key)
      this.cache.set(key, entry!)
      return cached
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    options.signal.addEventListener('abort', cancel, { once: true })
    const pending = this.pending.get(key) ?? new Set<AbortController>()
    pending.add(controller)
    this.pending.set(key, pending)
    try {
      return await this.readNativeFile(key, request, { ...options, signal: controller.signal })
    } finally {
      options.signal.removeEventListener('abort', cancel)
      pending.delete(controller)
      if (pending.size === 0) this.pending.delete(key)
    }
  }

  private async readNativeFile(
    key: string,
    request: MobileFileRequest,
    options: FileLoadOptions
  ): Promise<NativeFileRead> {
    const { Directory, File, Paths } = await import('expo-file-system')
    this.assertActive(options.signal)
    if (!this.directory) {
      this.directory = new Directory(
        Paths.cache,
        `wework-files-${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      this.directory.create({ intermediates: true })
    }
    const directory = new Directory(
      this.directory,
      `${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    directory.create()
    const name = mobileFileName(request)
    const file = new File(directory, name.replace(/[\\/\0]/g, '_') || 'file')
    try {
      const result = await this.read(request, file, options)
      this.assertActive(options.signal)
      const loaded: NativeFileRead = {
        ...result,
        directory,
        cached: true,
        leases: 1,
        bytes: file.size,
      }
      this.files.add(loaded)
      this.cacheFile(key, loaded, !!options.complete)
      return loaded
    } catch (error) {
      if (directory.exists) directory.delete()
      throw error
    }
  }

  invalidate(request: MobileFileRequest) {
    const key = mobileFileKey(request)
    for (const controller of this.pending.get(key) ?? []) controller.abort()
    this.removeCached(key)
  }

  dispose() {
    this.disposed = true
    for (const pending of this.pending.values())
      for (const controller of pending) controller.abort()
    this.cache.clear()
    for (const file of this.files) {
      file.cached = false
      this.deleteUnused(file)
    }
    this.deleteDisposedDirectory()
  }

  private assertActive(signal: AbortSignal) {
    if (this.disposed) throw new Error('文件预览会话已关闭')
    throwIfAborted(signal)
  }

  private releaseFile(file: NativeFileRead) {
    file.leases -= 1
    this.deleteUnused(file)
    this.prune()
  }

  private cacheFile(key: string, loaded: NativeFileRead, complete: boolean) {
    const previous = this.cache.get(key)
    const current = { ...previous }
    if (complete) current.complete = loaded
    else {
      current.preview = loaded
      if (loaded.complete) current.complete = loaded
    }
    this.cache.delete(key)
    this.cache.set(key, current)
    for (const file of new Set([previous?.preview, previous?.complete])) {
      if (file && file !== current.preview && file !== current.complete) {
        file.cached = false
        this.deleteUnused(file)
      }
    }
    this.prune()
  }

  private prune() {
    let bytes = [...this.files].reduce((total, file) => total + file.bytes, 0)
    const newest = [...this.cache.keys()].at(-1)
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= CACHE_FILE_COUNT && bytes <= CACHE_TARGET_BYTES) break
      if (key === newest || entry.preview?.leases || entry.complete?.leases) continue
      const removed = new Set([entry.preview, entry.complete])
      this.removeCached(key)
      for (const file of removed) if (file) bytes -= file.bytes
    }
  }

  private removeCached(key: string) {
    const entry = this.cache.get(key)
    this.cache.delete(key)
    for (const file of new Set([entry?.preview, entry?.complete])) {
      if (!file) continue
      file.cached = false
      this.deleteUnused(file)
    }
  }

  private deleteUnused(file: NativeFileRead) {
    if (file.cached || file.leases) return
    if (file.directory.exists) file.directory.delete()
    this.files.delete(file)
    this.deleteDisposedDirectory()
  }

  private deleteDisposedDirectory() {
    if (this.disposed && this.files.size === 0 && this.directory?.exists) this.directory.delete()
  }

  private withLineTarget(
    file: LoadedMobileFile,
    request: MobileFileRequest,
    complete = false
  ): LoadedMobileFile {
    return {
      ...file,
      ...(complete && file.truncated ? { text: undefined, truncated: false } : {}),
      lineStart: request.kind === 'workspace' ? request.lineStart : undefined,
      lineEnd: request.kind === 'workspace' ? request.lineEnd : undefined,
    }
  }

  private async read(
    request: MobileFileRequest,
    file: import('expo-file-system').File,
    options: FileLoadOptions
  ): Promise<FileReadResult> {
    let name = mobileFileName(request)
    if (request.kind === 'diff') {
      const text = await this.api.readFileChangesDiff(request.summary)
      throwIfAborted(options.signal)
      file.write(text)
      return {
        complete: true,
        document: {
          name,
          path: request.path ?? '',
          mimeType: 'text/x-diff',
          size: file.size,
          uri: file.uri,
          text,
          kind: 'diff',
        },
      }
    }
    if (request.kind === 'attachment' && request.attachment.workspace_file) {
      const ref = request.attachment.workspace_file
      const target = { deviceId: ref.device_id, path: ref.workspace_path }
      const path = resolveWorkspaceFilePath(target, ref.path)
      if (!path) throw new Error('附件的设备文件路径无效')
      return this.read({ kind: 'workspace', target, path }, file, options)
    }
    if (request.kind === 'workspace') return this.readWorkspace(request, file, options)
    if (request.kind === 'image') {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(request.dataUri)
      if (!match) throw new Error('图片数据格式无效')
      const bytes = Uint8Array.from(atob(match[2]!), value => value.charCodeAt(0))
      if (!bytes.length) throw new Error('图片数据为空')
      file.write(bytes)
      return {
        complete: true,
        document: {
          name,
          path: name,
          mimeType: match[1]!.toLowerCase(),
          size: file.size,
          uri: file.uri,
          kind: 'binary',
        },
      }
    }
    let mimeType = request.kind === 'attachment' ? request.attachment.mime_type : request.mimeType
    if (request.kind === 'local') {
      if (!/^(?:file:\/\/\/|content:\/\/[^/])/i.test(request.uri)) {
        throw new Error('本机文件地址无效')
      }
      const { File } = await import('expo-file-system')
      throwIfAborted(options.signal)
      await new File(request.uri).copy(file)
    } else {
      const downloaded = await this.api.downloadAttachment(request.attachment.id, file.uri, {
        signal: options.signal,
      })
      name = downloaded.filename ?? name
      if (downloaded.filename && downloaded.filename !== file.name) file.rename(downloaded.filename)
      if (downloaded.mimeType && downloaded.mimeType !== 'application/octet-stream')
        mimeType = downloaded.mimeType
    }
    throwIfAborted(options.signal)
    return {
      complete: true,
      document: await this.describe(file, name, name, mimeType, options.complete),
    }
  }

  private async readWorkspace(
    request: Extract<MobileFileRequest, { kind: 'workspace' }>,
    file: import('expo-file-system').File,
    options: FileLoadOptions
  ): Promise<FileReadResult> {
    const { deviceId, path: root } = request.target
    const kind = workspaceFilePreviewKind(request.path)
    if (kind === 'text' && !options.complete) {
      const result = await this.api.readWorkspaceTextFile(deviceId, request.path, root)
      throwIfAborted(options.signal)
      file.write(result.content)
      return {
        complete: !result.truncated,
        document: {
          name: result.name,
          path: request.path,
          size: result.size,
          uri: file.uri,
          mimeType: mimeTypeForFileName(result.name),
          text: result.content,
          truncated: result.truncated,
          kind: 'text',
          lineStart: request.lineStart,
          lineEnd: request.lineEnd,
        },
      }
    }
    file.create()
    const handle = file.open()
    try {
      await copyWorkspaceFileChunks(
        offset => this.api.readWorkspaceFileChunk(deviceId, request.path, offset, root),
        bytes => handle.writeBytes(bytes),
        options
      )
    } finally {
      handle.close()
    }
    const loaded = await this.describe(
      file,
      mobileFileName(request),
      request.path,
      mimeTypeForFileName(request.path),
      options.complete
    )
    return {
      complete: true,
      document: { ...loaded, lineStart: request.lineStart, lineEnd: request.lineEnd },
    }
  }

  private async describe(
    file: import('expo-file-system').File,
    name: string,
    path: string,
    mimeType: string,
    complete = false
  ): Promise<LoadedMobileFile> {
    let kind = workspaceFilePreviewKind(name, mimeType)
    // Attachments preserve PC's spreadsheet presentation for CSV and TSV.
    if (path === name && /\.(csv|tsv)$/i.test(name)) kind = 'binary'
    const metadata = { name, path, size: file.size, uri: file.uri, mimeType }
    // A complete load is a native share/download operation, never a JS text read.
    if (complete || kind === 'binary')
      return { ...metadata, kind: kind === 'text' ? 'text' : 'binary' }
    const handle = file.open()
    let bytes: Uint8Array
    try {
      bytes = handle.readBytes(Math.min(file.size, TEXT_PREVIEW_BYTES))
    } finally {
      handle.close()
    }
    const truncated = file.size > bytes.byteLength
    let text: string
    if (kind === 'unknown') {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
      } catch {
        return { ...metadata, kind: 'binary' }
      }
      if (!isLikelyTextContent(new TextEncoder().encode(text)))
        return { ...metadata, kind: 'binary' }
    } else {
      text = new TextDecoder().decode(bytes, { stream: truncated })
    }
    return { ...metadata, kind: 'text', text, truncated }
  }
}
