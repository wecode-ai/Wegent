import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '../../../packages/chat-core/src/runtime'
import type { WorkspaceFileChunkResponse } from '../../../packages/chat-core/src/workspace-files'
import type { MobileFileRequest } from '@/types/files'
import { copyWorkspaceFileChunks, MobileFileStore, type FileLoadOptions } from './mobileFileStore'
import type { RuntimeApi } from './runtimeApi'

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  sizes: new Map<string, number>(),
  directories: new Set<string>(),
  created: [] as string[],
  deleted: [] as string[],
  constructedFiles: [] as string[],
  writes: [] as Uint8Array[],
  reads: [] as number[],
  opened: 0,
  closed: 0,
  text: vi.fn(),
}))

vi.mock('expo-file-system', () => {
  function uri(parent: string | { uri: string }, name?: string) {
    return `${typeof parent === 'string' ? parent : parent.uri}${name ? `/${name}` : ''}`
  }
  return {
    Paths: { cache: 'file:///cache' },
    Directory: class {
      readonly uri: string
      constructor(parent: string | { uri: string }, name: string) {
        this.uri = uri(parent, name)
      }
      get exists() {
        return native.directories.has(this.uri)
      }
      create() {
        native.directories.add(this.uri)
        native.created.push(this.uri)
      }
      delete() {
        native.deleted.push(this.uri)
        for (const key of native.files.keys()) {
          if (key.startsWith(`${this.uri}/`)) {
            native.files.delete(key)
            native.sizes.delete(key)
          }
        }
        for (const key of native.directories) {
          if (key === this.uri || key.startsWith(`${this.uri}/`)) native.directories.delete(key)
        }
      }
    },
    File: class {
      uri: string
      constructor(parent: string | { uri: string }, name?: string) {
        this.uri = uri(parent, name)
        native.constructedFiles.push(this.uri)
      }
      get name() {
        return this.uri.slice(this.uri.lastIndexOf('/') + 1)
      }
      get size() {
        return native.sizes.get(this.uri) ?? native.files.get(this.uri)?.byteLength ?? 0
      }
      get exists() {
        return native.files.has(this.uri)
      }
      create() {
        native.files.set(this.uri, new Uint8Array())
      }
      write(value: string | Uint8Array) {
        native.files.set(
          this.uri,
          typeof value === 'string' ? new TextEncoder().encode(value) : value.slice()
        )
      }
      async copy(destination: { uri: string }) {
        const value = native.files.get(this.uri)
        if (!value) throw new Error('Source does not exist')
        native.files.set(destination.uri, value.slice())
      }
      rename(name: string) {
        const destination = `${this.uri.slice(0, this.uri.lastIndexOf('/'))}/${name}`
        const value = native.files.get(this.uri)
        if (!value) throw new Error('Source does not exist')
        native.files.delete(this.uri)
        native.files.set(destination, value)
        const size = native.sizes.get(this.uri)
        if (size !== undefined) native.sizes.set(destination, size)
        native.sizes.delete(this.uri)
        this.uri = destination
      }
      text = native.text
      open() {
        if (!native.files.has(this.uri)) throw new Error('File does not exist')
        native.opened += 1
        const path = this.uri
        let offset = 0
        return {
          readBytes(length: number) {
            native.reads.push(length)
            const bytes = native.files.get(path)!.slice(offset, offset + length)
            offset += bytes.length
            return bytes
          },
          writeBytes(bytes: Uint8Array) {
            const previous = native.files.get(path)!
            const next = new Uint8Array(offset + bytes.length)
            next.set(previous)
            next.set(bytes, offset)
            offset += bytes.length
            native.files.set(path, next)
            native.writes.push(bytes.slice())
          },
          close() {
            native.closed += 1
          },
        }
      }
    },
  }
})

function chunk(
  content: string,
  offset = 0,
  size = content.length,
  eof = true
): WorkspaceFileChunkResponse {
  return {
    path: '/repo/file.bin',
    name: 'file.bin',
    contentBase64: btoa(content),
    offset,
    size,
    eof,
  }
}

function options() {
  return { signal: new AbortController().signal }
}

async function load(
  store: MobileFileStore,
  request: MobileFileRequest,
  loadOptions: FileLoadOptions
) {
  const lease = await store.acquire(request, loadOptions)
  try {
    return lease.document
  } finally {
    lease.release()
  }
}

function workspace(
  path = '/repo/readme.md',
  extra: Partial<Extract<MobileFileRequest, { kind: 'workspace' }>> = {}
): MobileFileRequest {
  return { kind: 'workspace', path, target: { deviceId: 'device', path: '/repo' }, ...extra }
}

function attachment(extra: Partial<Attachment> = {}): MobileFileRequest {
  return {
    kind: 'attachment',
    attachment: {
      id: 7,
      filename: 'document.pdf',
      file_size: 3,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: 'pdf',
      created_at: '2026-11-14',
      ...extra,
    },
  }
}

function setup() {
  const api = {
    readWorkspaceTextFile: vi.fn().mockResolvedValue({
      path: '/repo/readme.md',
      name: 'readme.md',
      size: 7,
      content: 'preview',
      truncated: false,
    }),
    readWorkspaceFileChunk: vi.fn().mockResolvedValue(chunk('abc')),
    readFileChangesDiff: vi.fn(),
    downloadAttachment: vi.fn(
      async (_id: number, destination: string, _options?: { signal?: AbortSignal }) => {
        native.files.set(destination, new TextEncoder().encode('pdf'))
        return {} as { filename?: string; mimeType?: string }
      }
    ),
  }
  return { api, store: new MobileFileStore(api as unknown as RuntimeApi) }
}

beforeEach(() => {
  native.files.clear()
  native.sizes.clear()
  native.directories.clear()
  native.created.length = 0
  native.deleted.length = 0
  native.constructedFiles.length = 0
  native.writes.length = 0
  native.reads.length = 0
  native.opened = 0
  native.closed = 0
  native.text.mockReset()
})

describe('copyWorkspaceFileChunks', () => {
  it('writes each validated chunk before requesting the next, without accumulating the file', async () => {
    const events: string[] = []
    const onProgress = vi.fn()
    const read = vi.fn(async (offset: number) => {
      events.push(`read:${offset}`)
      return offset === 0 ? chunk('abc', 0, 5, false) : chunk('de', 3, 5)
    })
    const size = await copyWorkspaceFileChunks(
      read,
      bytes => events.push(`write:${bytes.length}`),
      {
        ...options(),
        onProgress,
      }
    )
    expect(size).toBe(5)
    expect(events).toEqual(['read:0', 'write:3', 'read:3', 'write:2'])
    expect(onProgress.mock.calls).toEqual([
      [3, 5],
      [5, 5],
    ])
  })

  it('accepts an empty file only with EOF', async () => {
    await expect(copyWorkspaceFileChunks(async () => chunk(''), vi.fn(), options())).resolves.toBe(
      0
    )
  })

  it.each([
    ['negative size', { size: -1 }],
    ['fractional size', { size: 1.5 }],
    ['unsafe size', { size: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong offset', { offset: 1 }],
    ['overflow', { size: 2 }],
    ['early EOF', { size: 4 }],
    ['missing EOF', { eof: false }],
    ['invalid EOF type', { eof: 'true' }],
    ['malformed base64', { contentBase64: '***' }],
    ['non-string base64', { contentBase64: 123 }],
    ['empty intermediate chunk', { contentBase64: '', eof: false }],
  ])('rejects %s', async (_name, invalid) => {
    const read = vi.fn(async () => ({ ...chunk('abc'), ...invalid }) as WorkspaceFileChunkResponse)
    await expect(copyWorkspaceFileChunks(read, vi.fn(), options())).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('rejects a changing file size and does not write the inconsistent chunk', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(chunk('ab', 0, 4, false))
      .mockResolvedValueOnce(chunk('cd', 2, 5))
    const write = vi.fn()
    await expect(copyWorkspaceFileChunks(read, write, options())).rejects.toThrow('无效的文件分片')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not read when already cancelled or write a response received after cancellation', async () => {
    const controller = new AbortController()
    const read = vi.fn(async () => {
      controller.abort()
      return chunk('abc')
    })
    const write = vi.fn()
    await expect(
      copyWorkspaceFileChunks(read, write, { signal: controller.signal })
    ).rejects.toThrow('取消')
    expect(write).not.toHaveBeenCalled()
    await expect(
      copyWorkspaceFileChunks(read, write, { signal: controller.signal })
    ).rejects.toThrow('取消')
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('MobileFileStore', () => {
  it('shares the full native file after a truncated preview without rereading the whole file into JS', async () => {
    const { api, store } = setup()
    api.readWorkspaceTextFile.mockResolvedValue({
      name: 'readme.md',
      path: '/repo/readme.md',
      content: 'pre',
      size: 6,
      truncated: true,
    })
    api.readWorkspaceFileChunk
      .mockResolvedValueOnce(chunk('abc', 0, 6, false))
      .mockResolvedValueOnce(chunk('def', 3, 6))
    const preview = await load(store, workspace(), options())
    const complete = await load(store, workspace(), { ...options(), complete: true })
    expect(preview).toMatchObject({ text: 'pre', truncated: true, size: 6 })
    expect(complete).toMatchObject({ size: 6, kind: 'text' })
    expect(complete.text).toBeUndefined()
    expect(complete.truncated).not.toBe(true)
    expect(new TextDecoder().decode(native.files.get(complete.uri))).toBe('abcdef')
    expect(native.text).not.toHaveBeenCalled()
    expect(native.reads).toEqual([])
    expect(await load(store, workspace(), options())).toMatchObject({
      uri: preview.uri,
      text: 'pre',
    })
    expect(await load(store, workspace(), { ...options(), complete: true })).toMatchObject({
      uri: complete.uri,
    })
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(2)
    expect(native.opened).toBe(native.closed)
  })

  it('shares a complete preview without downloading again and refreshes line navigation on cache hits', async () => {
    const { api, store } = setup()
    const first = await load(
      store,
      workspace('/repo/readme.md', { lineStart: 3, lineEnd: 5 }),
      options()
    )
    const next = await load(store, workspace('/repo/readme.md', { lineStart: 20 }), options())
    expect(next).toMatchObject({ uri: first.uri, lineStart: 20 })
    expect(next.lineEnd).toBeUndefined()
    expect((await load(store, workspace(), { ...options(), complete: true })).uri).toBe(first.uri)
    expect(api.readWorkspaceTextFile).toHaveBeenCalledTimes(1)
    expect(api.readWorkspaceFileChunk).not.toHaveBeenCalled()
  })

  it('does not serve metadata-only complete loads as text previews', async () => {
    const { api, store } = setup()
    await load(store, workspace(), { ...options(), complete: true })
    expect((await load(store, workspace(), options())).text).toBe('preview')
    expect(api.readWorkspaceTextFile).toHaveBeenCalledTimes(1)
  })

  it('uses an attachment workspace reference instead of its numeric ID or remote local_path', async () => {
    const { api, store } = setup()
    const request = attachment({
      filename: 'readme.md',
      local_path: '/different/device/file.md',
      workspace_file: {
        device_id: 'original-device',
        workspace_path: '/original/worktree',
        path: 'readme.md',
      },
    })
    await load(store, request, options())
    expect(api.readWorkspaceTextFile).toHaveBeenCalledWith(
      'original-device',
      '/original/worktree/readme.md',
      '/original/worktree'
    )
    expect(api.downloadAttachment).not.toHaveBeenCalled()
    expect(native.constructedFiles).not.toContain('/different/device/file.md')
  })

  it('passes cancellation to native attachment downloading and never treats local_path as a phone path', async () => {
    const { api, store } = setup()
    const loadOptions = options()
    const result = await load(store, attachment({ local_path: '/remote/file.pdf' }), loadOptions)
    expect(api.downloadAttachment).toHaveBeenCalledWith(7, result.uri, {
      signal: expect.any(AbortSignal),
    })
    expect(native.constructedFiles).not.toContain('/remote/file.pdf')
    expect(native.text).not.toHaveBeenCalled()
  })

  it('uses response filename and MIME to render and share a raw attachment link', async () => {
    const { api, store } = setup()
    api.downloadAttachment.mockImplementationOnce(async (_id, destination) => {
      native.files.set(destination, new TextEncoder().encode('pdf'))
      return { filename: '报告.pdf', mimeType: 'application/pdf' }
    })
    const result = await load(
      store,
      attachment({
        filename: 'attachment-7',
        mime_type: 'application/octet-stream',
        file_extension: '',
      }),
      options()
    )
    expect(result).toMatchObject({ name: '报告.pdf', mimeType: 'application/pdf', kind: 'binary' })
    expect(result.uri.endsWith('/报告.pdf')).toBe(true)
    expect(native.files.has(result.uri)).toBe(true)
  })

  it('copies an explicit phone URI without invoking a remote API', async () => {
    const { api, store } = setup()
    native.files.set('file:///phone/document.pdf', new Uint8Array([1, 2, 3]))
    const result = await load(
      store,
      {
        kind: 'local',
        uri: 'file:///phone/document.pdf',
        name: 'document.pdf',
        mimeType: 'application/pdf',
      },
      options()
    )
    expect(native.files.get(result.uri)).toEqual(new Uint8Array([1, 2, 3]))
    expect(api.downloadAttachment).not.toHaveBeenCalled()
    expect(api.readWorkspaceFileChunk).not.toHaveBeenCalled()
  })

  it.each([
    'https://example.com/file.pdf',
    '/remote/file.pdf',
    'C:\\file.pdf',
    'data:application/pdf;base64,YWJj',
  ])('rejects non-phone local URI %s', async uri => {
    const { api, store } = setup()
    await expect(
      load(
        store,
        { kind: 'local', uri, name: 'document.pdf', mimeType: 'application/pdf' },
        options()
      )
    ).rejects.toThrow('本机文件地址无效')
    expect(native.constructedFiles).not.toContain(uri)
    expect(api.downloadAttachment).not.toHaveBeenCalled()
  })

  it('writes validated embedded image bytes to a native file without treating the data URI as a path', async () => {
    const { api, store } = setup()
    const request = {
      kind: 'image',
      dataUri: 'data:image/png;base64,YWJj',
      name: 'output.png',
    } as const
    const file = await load(store, request, options())
    expect(file).toMatchObject({ kind: 'binary', size: 3, mimeType: 'image/png' })
    expect(native.files.get(file.uri)).toEqual(new TextEncoder().encode('abc'))
    expect(native.constructedFiles).not.toContain(request.dataUri)
    expect(api.downloadAttachment).not.toHaveBeenCalled()
  })

  it.each([
    'data:text/html;base64,YWJj',
    'data:image/png,abc',
    'data:image/png;base64,***',
    'data:image/png;base64,a',
    'https://example.com/a.png',
  ])('rejects invalid embedded image %s', async dataUri => {
    const { store } = setup()
    await expect(
      load(store, { kind: 'image', dataUri, name: 'image.png' }, options())
    ).rejects.toThrow()
    expect(native.files.size).toBe(0)
  })

  it('limits unknown text previews without truncating the native file or falsely claiming a full preview', async () => {
    const { api, store } = setup()
    const size = 256 * 1024 + 4
    api.readWorkspaceFileChunk.mockResolvedValue(chunk('x'.repeat(size), 0, size))
    const result = await load(store, workspace('/repo/result.custom'), options())
    expect(result).toMatchObject({ kind: 'text', size, truncated: true })
    expect(result.text?.length).toBe(256 * 1024)
    expect(native.files.get(result.uri)?.length).toBe(size)
    expect(native.reads).toEqual([256 * 1024])
    expect(native.text).not.toHaveBeenCalled()
    expect(native.opened).toBe(native.closed)
    const shared = await load(store, workspace('/repo/result.custom'), {
      ...options(),
      complete: true,
    })
    expect(shared).toMatchObject({ uri: result.uri, size, truncated: false })
    expect(shared.text).toBeUndefined()
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(1)
  })

  it('does not misclassify UTF-8 text when the preview ends inside a multibyte character', async () => {
    const { api, store } = setup()
    const bytes = new TextEncoder().encode(`${'x'.repeat(256 * 1024 - 1)}中文`)
    api.readWorkspaceFileChunk.mockResolvedValue({
      ...chunk(''),
      contentBase64: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')),
      size: bytes.length,
    })
    const result = await load(store, workspace('/repo/result.custom'), options())
    expect(result).toMatchObject({ kind: 'text', truncated: true })
    expect(result.text).toBe('x'.repeat(256 * 1024 - 1))
  })

  it('keeps binary bytes out of the text renderer and preserves CSV attachment presentation', async () => {
    const { api, store } = setup()
    api.readWorkspaceFileChunk.mockResolvedValue(chunk('\0\xff'))
    const unknown = await load(store, workspace('/repo/result.custom'), options())
    const csv = await load(
      store,
      attachment({ filename: 'table.csv', mime_type: 'text/csv' }),
      options()
    )
    expect(unknown).toMatchObject({ kind: 'binary' })
    expect(unknown.text).toBeUndefined()
    expect(csv).toMatchObject({ kind: 'binary' })
    expect(csv.text).toBeUndefined()
  })

  it('deletes partial files, closes handles, and retries failures without poisoning the cache', async () => {
    const { api, store } = setup()
    api.readWorkspaceFileChunk.mockRejectedValueOnce(new Error('Device offline'))
    await expect(load(store, workspace('/repo/file.pdf'), options())).rejects.toThrow(
      'Device offline'
    )
    expect(native.files.size).toBe(0)
    expect(native.deleted).toHaveLength(1)
    expect(native.opened).toBe(native.closed)
    await expect(load(store, workspace('/repo/file.pdf'), options())).resolves.toMatchObject({
      size: 3,
    })
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(2)
  })

  it('does not cache a text response received after cancellation', async () => {
    const { api, store } = setup()
    const controller = new AbortController()
    api.readWorkspaceTextFile.mockImplementationOnce(async () => {
      controller.abort()
      return {
        name: 'readme.md',
        path: '/repo/readme.md',
        content: 'cancelled',
        size: 9,
        truncated: false,
      }
    })
    await expect(load(store, workspace(), { signal: controller.signal })).rejects.toThrow('取消')
    expect(native.files.size).toBe(0)
    expect((await load(store, workspace(), options())).text).toBe('preview')
    expect(api.readWorkspaceTextFile).toHaveBeenCalledTimes(2)
  })

  it('does not cache or retain cancelled native downloads and starts a fresh download on retry', async () => {
    const { api, store } = setup()
    const controller = new AbortController()
    api.downloadAttachment.mockImplementationOnce(async (_id: number, destination: string) => {
      native.files.set(destination, new Uint8Array([1]))
      controller.abort()
      return {}
    })
    await expect(load(store, attachment(), { signal: controller.signal })).rejects.toThrow('取消')
    expect(native.files.size).toBe(0)
    await expect(load(store, attachment(), options())).resolves.toMatchObject({ size: 3 })
    expect(api.downloadAttachment).toHaveBeenCalledTimes(2)
  })

  it('removes corrupt streamed files rather than caching them', async () => {
    const { api, store } = setup()
    api.readWorkspaceFileChunk.mockResolvedValueOnce(chunk('abc', 0, 9))
    await expect(load(store, workspace('/repo/file.pdf'), options())).rejects.toThrow(
      '文件下载未完成'
    )
    expect(native.files.size).toBe(0)
    expect(native.opened).toBe(native.closed)
    await expect(load(store, workspace('/repo/file.pdf'), options())).resolves.toMatchObject({
      size: 3,
    })
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(2)
  })

  it('rechecks disposal after lazy native module loading and creates no orphan directory', async () => {
    const { store } = setup()
    const pending = load(store, workspace(), options())
    store.dispose()
    await expect(pending).rejects.toThrow('会话已关闭')
    expect(native.created).toEqual([])
  })

  it('clears session files on disposal and invalidates successful cache entries explicitly', async () => {
    const { api, store } = setup()
    const original = await load(store, workspace(), options())
    store.invalidate(workspace())
    expect(native.files.has(original.uri)).toBe(false)
    expect(native.directories.has(original.uri.slice(0, original.uri.lastIndexOf('/')))).toBe(false)
    await load(store, workspace(), options())
    expect(api.readWorkspaceTextFile).toHaveBeenCalledTimes(2)
    store.dispose()
    expect(native.files.size).toBe(0)
    expect(native.directories.size).toBe(0)
    await expect(load(store, workspace(), options())).rejects.toThrow('会话已关闭')
  })

  it('does not let an in-flight read repopulate a refreshed cache with stale content', async () => {
    const { api, store } = setup()
    let finish: (value: Awaited<ReturnType<typeof api.readWorkspaceTextFile>>) => void = () => {}
    api.readWorkspaceTextFile.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const pending = load(store, workspace(), options())
    await vi.waitFor(() => expect(api.readWorkspaceTextFile).toHaveBeenCalledOnce())
    store.invalidate(workspace())
    finish({
      path: '/repo/readme.md',
      name: 'readme.md',
      content: 'stale',
      size: 5,
      truncated: false,
    })
    await expect(pending).rejects.toThrow('取消')
    expect(native.files.size).toBe(0)
    expect((await load(store, workspace(), options())).text).toBe('preview')
    expect(api.readWorkspaceTextFile).toHaveBeenCalledTimes(2)
  })

  it.each(['invalidate', 'dispose', 'external cancellation'] as const)(
    'cancels active native downloads on %s',
    async action => {
      const { api, store } = setup()
      const controller = new AbortController()
      let downloadSignal: AbortSignal | undefined
      api.downloadAttachment.mockImplementationOnce((_id, destination, downloadOptions) => {
        native.files.set(destination, new Uint8Array([1]))
        downloadSignal = downloadOptions?.signal
        return new Promise((_resolve, reject) => {
          downloadSignal?.addEventListener('abort', () => reject(new Error('文件读取已取消')), {
            once: true,
          })
        })
      })
      const pending = store.acquire(attachment(), { signal: controller.signal, complete: true })
      await vi.waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledOnce())
      if (action === 'invalidate') store.invalidate(attachment())
      else if (action === 'dispose') store.dispose()
      else controller.abort()
      expect(downloadSignal?.aborted).toBe(true)
      await expect(pending).rejects.toThrow('取消')
      expect(native.files.size).toBe(0)
    }
  )

  it('does not hand out a cached lease after disposal and leaves no pinned file', async () => {
    const { store } = setup()
    await load(store, workspace(), options())
    const pending = store.acquire(workspace(), { ...options(), complete: true })
    store.dispose()
    await expect(pending).rejects.toThrow('会话已关闭')
    expect(native.files.size).toBe(0)
    expect(native.directories.size).toBe(0)
  })

  it('keeps simultaneous leases valid when a later completed read replaces the cache entry', async () => {
    const { api, store } = setup()
    const finish: ((value: Awaited<ReturnType<typeof api.readWorkspaceTextFile>>) => void)[] = []
    api.readWorkspaceTextFile.mockImplementation(
      () =>
        new Promise(resolve => {
          finish.push(resolve)
        })
    )
    const firstRead = store.acquire(workspace(), options())
    await vi.waitFor(() => expect(api.readWorkspaceTextFile).toHaveBeenCalledOnce())
    const secondRead = store.acquire(workspace(), options())
    await vi.waitFor(() => expect(api.readWorkspaceTextFile).toHaveBeenCalledTimes(2))
    const response = {
      path: '/repo/readme.md',
      name: 'readme.md',
      content: 'preview',
      size: 7,
      truncated: false,
    }
    finish[1]!(response)
    finish[0]!(response)
    const [first, second] = await Promise.all([firstRead, secondRead])
    expect(native.files.has(first.document.uri)).toBe(true)
    expect(native.files.has(second.document.uri)).toBe(true)
    expect(first.document.uri).not.toBe(second.document.uri)
    store.invalidate(workspace())
    first.release()
    expect(native.files.has(first.document.uri)).toBe(false)
    expect(native.files.has(second.document.uri)).toBe(true)
    second.release()
    store.dispose()
    expect(native.files.size).toBe(0)
    expect(native.directories.size).toBe(0)
  })

  it('evicts least recently used file directories after 30 cached requests', async () => {
    const { store } = setup()
    const first = await load(store, workspace('/repo/first.md'), options())
    const second = await load(store, workspace('/repo/second.md'), options())
    for (let index = 0; index < 28; index += 1)
      await load(store, workspace(`/repo/${index}.md`), options())
    await load(store, workspace('/repo/first.md'), options())
    await load(store, workspace('/repo/new.md'), options())
    expect(native.files.has(first.uri)).toBe(true)
    expect(native.files.has(second.uri)).toBe(false)
    expect(native.files.size).toBe(30)
    expect(native.directories.size).toBe(31)
  })

  it('evicts by native byte usage and permits the current file to exceed the cache target', async () => {
    const { api, store } = setup()
    api.downloadAttachment.mockImplementation(async (id, destination) => {
      native.files.set(destination, new Uint8Array([1]))
      native.sizes.set(destination, (id === 3 ? 300 : 140) * 1024 * 1024)
      return {}
    })
    const first = await load(store, attachment({ id: 1 }), options())
    const second = await load(store, attachment({ id: 2 }), options())
    expect(native.files.has(first.uri)).toBe(false)
    expect(native.files.has(second.uri)).toBe(true)
    const large = await load(store, attachment({ id: 3 }), options())
    expect(large.size).toBe(300 * 1024 * 1024)
    expect(native.files.has(second.uri)).toBe(false)
    expect(native.files.has(large.uri)).toBe(true)
  })

  it('counts stored preview bytes instead of the full remote file size', async () => {
    const { api, store } = setup()
    api.readWorkspaceTextFile.mockResolvedValue({
      path: '/repo/large.md',
      name: 'large.md',
      size: 300 * 1024 * 1024,
      content: 'preview',
      truncated: true,
    })
    const first = await load(store, workspace('/repo/first.md'), options())
    await load(store, workspace('/repo/second.md'), options())
    expect(native.files.has(first.uri)).toBe(true)
    expect(native.files.size).toBe(2)
  })

  it('keeps share leases readable across invalidation and disposal until every share finishes', async () => {
    const { store } = setup()
    const first = await store.acquire(workspace(), { ...options(), complete: true })
    const second = await store.acquire(workspace(), { ...options(), complete: true })
    expect(first.document.uri).toBe(second.document.uri)
    store.invalidate(workspace())
    await load(store, workspace(), options())
    store.dispose()
    expect(native.files.has(first.document.uri)).toBe(true)
    expect(native.files.size).toBe(1)
    first.release()
    first.release()
    expect(native.files.has(second.document.uri)).toBe(true)
    second.release()
    expect(native.files.size).toBe(0)
    expect(native.directories.size).toBe(0)
  })

  it('protects active shares during LRU eviction and reclaims them on release', async () => {
    const { api, store } = setup()
    api.downloadAttachment.mockImplementation(async (_id, destination) => {
      native.files.set(destination, new Uint8Array([1]))
      native.sizes.set(destination, 200 * 1024 * 1024)
      return {}
    })
    const shared = await store.acquire(attachment({ id: 1 }), { ...options(), complete: true })
    const current = await load(store, attachment({ id: 2 }), options())
    expect(native.files.has(shared.document.uri)).toBe(true)
    expect(native.files.has(current.uri)).toBe(true)
    shared.release()
    expect(native.files.has(shared.document.uri)).toBe(false)
    expect(native.files.has(current.uri)).toBe(true)
  })
})
