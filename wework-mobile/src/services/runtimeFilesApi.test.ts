import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnFileChangesSummary } from '../../../packages/chat-core/src/runtime'
import { RuntimeApi, RuntimeApiError } from './runtimeApi'
import { installReactNativeAbortGlobals } from '../../test/reactNativeAbortController'

const native = vi.hoisted(() => ({
  files: new Set<string>(),
  download: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('expo-file-system', () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return native.files.has(this.uri)
    }
    delete() {
      native.remove(this.uri)
      native.files.delete(this.uri)
    }
  },
}))

vi.mock('expo-file-system/legacy', () => ({
  FileSystemSessionType: { FOREGROUND: 1 },
  createDownloadResumable: (url: string, destination: string, options: unknown) => ({
    downloadAsync: () => native.download(url, destination, options),
    cancelAsync: native.cancel,
  }),
}))

const config = {
  backendUrl: 'https://wegent.example',
  apiBaseUrl: 'https://wegent.example/api',
  socketBaseUrl: 'https://wegent.example',
  socketPath: '/socket.io',
  accessToken: 'initial-token',
}

const artifact: TurnFileChangesSummary = {
  version: 1,
  status: 'active',
  device_id: 'artifact-device',
  workspace_path: '/original/worktree',
  artifact_id: 'turn-file-changes/turn-1',
  file_count: 1,
  additions: 1,
  deletions: 0,
  files: [{ path: 'a.ts', change_type: 'created', additions: 1, deletions: 0, binary: false }],
}

function command(stdout: unknown, success = true) {
  return new Response(JSON.stringify({ success, stdout }))
}

function textFile(path = '/project/readme.md') {
  return { path, name: 'readme.md', content: '# Readme', truncated: false, size: 8 }
}

function chunk(offset = 0) {
  return {
    path: '/project/image.png',
    name: 'image.png',
    content_base64: 'YWJj',
    offset,
    size: offset + 3,
    eof: true,
  }
}

describe('RuntimeApi file protocols', () => {
  beforeEach(() => {
    installReactNativeAbortGlobals()
    native.files.clear()
    native.download.mockReset()
    native.download.mockResolvedValue({ status: 200, headers: {}, mimeType: null })
    native.cancel.mockReset()
    native.cancel.mockResolvedValue(undefined)
    native.remove.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lists the selected device directory with the exact PC command and auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      command({
        path: '/project',
        entries: [{ name: 'src', path: '/project/src', is_directory: true, size: 0 }],
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await new RuntimeApi(config).listWorkspaceDirectory('device/one', '/project/.')
    expect(fetchMock).toHaveBeenCalledWith(
      `${config.apiBaseUrl}/devices/device%2Fone/commands`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer initial-token' }),
        body: JSON.stringify({
          command_key: 'workspace_tree',
          path: '/project',
          timeout_seconds: 15,
          max_output_bytes: 512 * 1024,
        }),
      })
    )
    expect(result).toEqual({
      path: '/project',
      entries: [
        { name: 'src', path: '/project/src', isDirectory: true, size: 0, modifiedAt: null },
      ],
    })
  })

  it.each([
    null,
    { success: 'true', stdout: {} },
    { success: true, stdout: 'not a directory object' },
    { success: true, stdout: { path: '/other', entries: [] } },
    {
      success: true,
      stdout: {
        path: '/project',
        entries: [{ name: 'secret', path: '/outside/secret', is_directory: false, size: 1 }],
      },
    },
  ])('rejects invalid or mismatched directory responses: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))))
    await expect(
      new RuntimeApi(config).listWorkspaceDirectory('device', '/project')
    ).rejects.toThrow()
  })

  it('reads absolute files outside the task workspace and preserves Windows identity', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        command({ ...textFile('C:/Other/readme.md'), editable: true, revision: 'revision' })
      )
    vi.stubGlobal('fetch', fetchMock)
    const file = await new RuntimeApi(config).readWorkspaceTextFile(
      'windows-device',
      'c:\\Other\\readme.md',
      'C:\\Task\\worktree'
    )
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      command_key: 'workspace_read_text_file',
      path: 'C:/Other',
      args: ['readme.md'],
      timeout_seconds: 15,
      max_output_bytes: 2 * 1024 * 1024,
    })
    expect(file).toMatchObject({
      path: 'C:\\Other\\readme.md',
      editable: true,
      revision: 'revision',
    })
  })

  it('normalizes UNC directories using the shared PC path contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(command({ path: '\\\\?\\UNC\\server\\share\\repo', entries: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      new RuntimeApi(config).listWorkspaceDirectory('device', '\\\\server\\share\\repo')
    ).resolves.toEqual({ path: '//server/share/repo', entries: [] })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).path).toBe('//server/share/repo')
  })

  it('rejects relative paths and invalid chunk offsets before contacting the device', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    await expect(api.listWorkspaceDirectory('device', 'relative')).rejects.toThrow('absolute')
    await expect(api.readWorkspaceTextFile('device', '../readme.md')).rejects.toThrow('absolute')
    for (const offset of [-1, 0.5, NaN, Infinity]) {
      await expect(
        api.readWorkspaceFileChunk('device', '/project/image.png', offset)
      ).rejects.toThrow()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { ...textFile(), content: 42 },
    { ...textFile('/project/other.md'), name: 'other.md' },
  ])('rejects malformed text or a different file: %j', async output => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(command(output)))
    await expect(
      new RuntimeApi(config).readWorkspaceTextFile('device', '/project/readme.md')
    ).rejects.toThrow('Invalid workspace text file response')
  })

  it('preserves text truncation and reads chunks using their exact offsets', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(command({ ...textFile(), truncated: true, size: 500000 }))
      .mockResolvedValueOnce(command(chunk(524288)))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    expect(await api.readWorkspaceTextFile('device', '/project/readme.md')).toMatchObject({
      truncated: true,
      size: 500000,
    })
    expect(
      await api.readWorkspaceFileChunk('device', '/project/image.png', 524288, '/project')
    ).toMatchObject({ offset: 524288, contentBase64: 'YWJj', eof: true })
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      command_key: 'workspace_read_file_chunk',
      path: '/project',
      args: ['image.png', '524288'],
      timeout_seconds: 30,
      max_output_bytes: 2 * 1024 * 1024,
    })
  })

  it.each([
    { ...chunk(), offset: 3 },
    { ...chunk(), name: 'another.png' },
    { ...chunk(), content_base64: null },
  ])('rejects malformed or wrong-position chunks: %j', async output => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(command(output)))
    await expect(
      new RuntimeApi(config).readWorkspaceFileChunk('device', '/project/image.png', 0)
    ).rejects.toThrow('Invalid workspace file chunk response')
  })

  it.each([
    { success: false, stdout: '', error: 'Device offline' },
    { success: false, stdout: '', stderr: 'File does not exist' },
    { success: true, stdout: { success: false, error: 'Access denied' } },
  ])('surfaces device errors without inventing empty data: %j', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    await expect(
      new RuntimeApi(config).readWorkspaceTextFile('device', '/project/readme.md')
    ).rejects.toThrow(
      response.error || response.stderr || (response.stdout as { error: string }).error
    )
  })

  it('keeps server authorization failures and never retries via another device', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Remote control is disabled for this app device' }), {
        status: 400,
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      new RuntimeApi(config).listWorkspaceDirectory('app-record-11', '/project')
    ).rejects.toBeInstanceOf(RuntimeApiError)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![0]).toContain('/devices/app-record-11/commands')
  })

  it('passes search identity and cancellation through unchanged and validates results', async () => {
    const result = {
      files: [
        {
          root: '/worktree',
          path: 'src/a.ts',
          fileName: 'a.ts',
          matchType: 'file',
          score: 7,
          indices: [0],
        },
      ],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(result)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ path: 'a.ts' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    await expect(
      api.searchWorkspaceEntries('device', '/worktree', 'a', 'search-1')
    ).resolves.toEqual(result)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${config.apiBaseUrl}/runtime-work/workspace/search`)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      deviceId: 'device',
      root: '/worktree',
      query: 'a',
      cancellationToken: 'search-1',
    })
    await expect(api.searchWorkspaceEntries('device', '/worktree', 'a')).rejects.toThrow(
      '无效的文件搜索结果'
    )
  })

  it('keeps overlapping directory requests independent when an older response arrives last', async () => {
    let resolveFirst!: (response: Response) => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(command({ path: '/second', entries: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    const first = api.listWorkspaceDirectory('first-device', '/first')
    const second = await api.listWorkspaceDirectory('second-device', '/second')
    resolveFirst(command({ path: '/first', entries: [] }))
    expect(await first).toEqual({ path: '/first', entries: [] })
    expect(second).toEqual({ path: '/second', entries: [] })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      `${config.apiBaseUrl}/devices/first-device/commands`,
      `${config.apiBaseUrl}/devices/second-device/commands`,
    ])
  })

  it('loads real diff from the artifact device and original worktree using the PC contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(command({ success: true, diff: 'diff --git a/a.ts b/a.ts' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await new RuntimeApi(config).readFileChangesDiff(artifact)).toBe(
      'diff --git a/a.ts b/a.ts'
    )
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${config.apiBaseUrl}/devices/artifact-device/commands`
    )
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      command_key: 'turn_file_changes_review',
      path: artifact.workspace_path,
      args: [artifact.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  it('uses inline diff without a request and surfaces missing or malformed artifacts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(command({ success: false, error: 'Artifact expired' }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    expect(await api.readFileChangesDiff({ ...artifact, diff: 'inline diff' })).toBe('inline diff')
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(api.readFileChangesDiff(undefined)).rejects.toThrow('artifact is unavailable')
    await expect(api.readFileChangesDiff(artifact)).rejects.toThrow('Artifact expired')
    fetchMock.mockResolvedValue(command({ success: true, diff: 42 }))
    await expect(api.readFileChangesDiff(artifact)).rejects.toThrow('File changes review failed')
  })

  it('downloads into native storage with the current token, without a web fetch', async () => {
    let token = 'first'
    const api = new RuntimeApi(config, undefined, () => token)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await api.downloadAttachment(42, 'file:///cache/first.pdf')
    token = 'refreshed'
    await api.downloadAttachment(43, 'file:///cache/second.pdf')
    expect(native.download.mock.calls.map(call => [call[0], call[1], call[2].headers])).toEqual([
      [
        `${config.apiBaseUrl}/attachments/42/download`,
        'file:///cache/first.pdf',
        { Authorization: 'Bearer first' },
      ],
      [
        `${config.apiBaseUrl}/attachments/43/download`,
        'file:///cache/second.pdf',
        { Authorization: 'Bearer refreshed' },
      ],
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['HTTP 403', 'Network disconnected'])(
    'propagates native download errors and removes its partial file: %s',
    async message => {
      const failure = new Error(message)
      native.download.mockImplementation(async (_url, destination) => {
        native.files.add(destination)
        throw failure
      })
      await expect(
        new RuntimeApi(config).downloadAttachment(42, 'file:///cache/file.pdf')
      ).rejects.toBe(failure)
      expect(native.remove).toHaveBeenCalledWith('file:///cache/file.pdf')
      expect(native.files.size).toBe(0)
    }
  )

  it('propagates cancellation to the native download and cleans its partial output', async () => {
    const controller = new AbortController()
    native.download.mockImplementation(
      (_url, destination) =>
        new Promise(resolve => {
          native.files.add(destination)
          native.cancel.mockImplementation(async () => resolve(undefined))
        })
    )
    const download = new RuntimeApi(config).downloadAttachment(42, 'file:///cache/cancelled.pdf', {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(native.download).toHaveBeenCalledOnce())
    controller.abort()
    await expect(download).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.cancel).toHaveBeenCalledOnce()
    expect(native.files.size).toBe(0)
  })

  it.each([
    ['attachment; filename="report.pdf"', 'report.pdf'],
    ["attachment; filename=ignored.pdf; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf", '报告.pdf'],
    ['attachment; filename="../private/report.pdf"', 'report.pdf'],
    [String.raw`attachment; filename="C:\\private\\report.pdf"`, 'report.pdf'],
    ["attachment; filename*=UTF-8''..%2Freport%00%0A.pdf", 'report.pdf'],
  ])('returns safe response metadata from %s', async (disposition, filename) => {
    native.download.mockResolvedValue({
      status: 200,
      mimeType: null,
      headers: {
        'Content-Disposition': disposition,
        'CONTENT-TYPE': 'Application/PDF; charset=utf-8',
      },
    })
    expect(await new RuntimeApi(config).downloadAttachment(42, 'file:///cache/file')).toEqual({
      filename,
      mimeType: 'application/pdf',
    })
  })

  it('uses native response MIME when Content-Type is unavailable', async () => {
    native.download.mockResolvedValue({ status: 200, headers: {}, mimeType: 'image/png' })
    expect(await new RuntimeApi(config).downloadAttachment(42, 'file:///cache/file')).toEqual({
      filename: undefined,
      mimeType: 'image/png',
    })
  })

  it.each([401, 403, 404, 500])(
    'rejects HTTP %s and removes the downloaded error body',
    async status => {
      native.download.mockImplementation(async (_url, destination) => {
        native.files.add(destination)
        return { status, headers: {}, mimeType: 'application/json' }
      })
      await expect(
        new RuntimeApi(config).downloadAttachment(42, 'file:///cache/file')
      ).rejects.toMatchObject({ status })
      expect(native.files.size).toBe(0)
    }
  )

  it('does not start native I/O after cancellation before module loading', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      new RuntimeApi(config).downloadAttachment(42, 'file:///cache/file', {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.download).not.toHaveBeenCalled()
  })

  it('does not delete or overwrite a preexisting download destination', async () => {
    native.files.add('file:///cache/existing.pdf')
    await expect(
      new RuntimeApi(config).downloadAttachment(42, 'file:///cache/existing.pdf')
    ).rejects.toThrow('目标已存在')
    expect(native.download).not.toHaveBeenCalled()
    expect(native.remove).not.toHaveBeenCalled()
    expect(native.files.has('file:///cache/existing.pdf')).toBe(true)
  })
})
