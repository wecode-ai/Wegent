import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  fileUrlToPath,
  readClipboardFileUriPaths,
  readNativeDroppedWorkspacePaths,
  resolveDataTransferWorkspacePaths,
  resolveStoredWorkspacePaths,
} from './workspace-path-transfer'

const mocks = vi.hoisted(() => ({
  desktopHost: vi.fn(),
  readDroppedFiles: vi.fn(),
}))

vi.mock('./runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.desktopHost,
}))

vi.mock('@/desktop/droppedFiles', () => ({
  readDroppedFiles: mocks.readDroppedFiles,
}))

function clipboardData(values: Record<string, string>, files: File[] = []): DataTransfer {
  return {
    files,
    getData: (type: string) => values[type] ?? '',
  } as DataTransfer
}

describe('workspace path transfer', () => {
  beforeEach(() => {
    mocks.desktopHost.mockReset()
    mocks.readDroppedFiles.mockReset()
    mocks.readDroppedFiles.mockResolvedValue([])
  })

  test('parses file URI clipboard formats and ignores comments and duplicates', () => {
    const data = clipboardData({
      'text/uri-list': [
        '# copied files',
        'file:///Users/alice/project/frontend',
        'file:///Users/alice/project/large%20file.bin',
      ].join('\r\n'),
      'public.file-url': 'file:///Users/alice/project/frontend',
    })

    expect(readClipboardFileUriPaths(data)).toEqual([
      '/Users/alice/project/frontend',
      '/Users/alice/project/large file.bin',
    ])
  })

  test('converts Windows file URIs to drive paths without a leading slash', () => {
    expect(fileUrlToPath('file:///D:/a/Wegent/dsh-e2e-smoke.zip')).toBe(
      'D:/a/Wegent/dsh-e2e-smoke.zip'
    )
  })

  test('uses Electron File paths when native drag data omits URI text', async () => {
    const file = new File(['context'], 'README.md', { type: 'text/markdown' })
    window.weworkElectronFiles = {
      getPathForFile: () => '/Users/alice/project/README.md',
    }
    const data = clipboardData({}, [file])
    mocks.desktopHost.mockResolvedValue([
      { path: '/Users/alice/project/README.md', isDirectory: false },
    ])

    await expect(readNativeDroppedWorkspacePaths(data)).resolves.toEqual([
      { path: '/Users/alice/project/README.md', isDirectory: false },
    ])
    expect(mocks.desktopHost).toHaveBeenCalledWith('filesystem.inspectPaths', {
      paths: ['/Users/alice/project/README.md'],
    })
    delete window.weworkElectronFiles
  })

  test('keeps dropped images as attachments', async () => {
    const file = new File(['image'], 'preview.png', { type: 'image/png' })
    const data = clipboardData({}, [file])

    await expect(resolveDataTransferWorkspacePaths(data, 'drop')).resolves.toEqual({
      attachmentFiles: [file],
      referenceEntries: [],
    })
    expect(mocks.desktopHost).not.toHaveBeenCalled()
  })

  test('keeps pasted files as attachments when no native path can be resolved', async () => {
    const file = new File(['archive'], 'feedback.zip', { type: 'application/zip' })
    const data = clipboardData({}, [file])
    mocks.desktopHost.mockResolvedValue([])

    await expect(resolveDataTransferWorkspacePaths(data, 'clipboard')).resolves.toEqual({
      attachmentFiles: [file],
      referenceEntries: [],
    })
    expect(mocks.desktopHost).toHaveBeenCalledWith('clipboard.readWorkspacePaths', {
      fallbackPaths: [],
    })
  })

  test('keeps ordinary dropped files as attachments when native path inspection fails', async () => {
    const file = new File(['archive'], 'feedback.zip', { type: 'application/zip' })
    const data = clipboardData({}, [file])
    mocks.desktopHost.mockRejectedValue(new Error('native inspection failed'))

    await expect(resolveDataTransferWorkspacePaths(data, 'drop')).resolves.toEqual({
      attachmentFiles: [file],
      referenceEntries: [],
    })
  })

  test('reads URI-only pasted files and excludes folder placeholders from attachments', async () => {
    const folder = new File([], 'docs')
    const file = new File(['test content'], 'test.md')
    mocks.desktopHost.mockResolvedValue([
      { path: '/tmp/docs', isDirectory: true },
      { path: '/tmp/test.md', isDirectory: false },
    ])
    mocks.readDroppedFiles.mockResolvedValue([file])
    const data = clipboardData({ 'text/uri-list': 'file:///tmp/docs\nfile:///tmp/test.md' }, [
      folder,
    ])

    await expect(resolveDataTransferWorkspacePaths(data, 'clipboard')).resolves.toEqual({
      attachmentFiles: [file],
      referenceEntries: [{ path: '/tmp/docs', isDirectory: true }],
    })
    expect(mocks.readDroppedFiles).toHaveBeenCalledWith(['/tmp/test.md'])
  })

  test('does not swallow a file read failure or replace the file with a reference', async () => {
    mocks.desktopHost.mockResolvedValue([{ path: '/tmp/test.md', isDirectory: false }])
    mocks.readDroppedFiles.mockRejectedValue(new Error('File unavailable'))

    await expect(resolveStoredWorkspacePaths(['/tmp/test.md'], false)).rejects.toThrow(
      'File unavailable'
    )
    await expect(
      resolveDataTransferWorkspacePaths(
        clipboardData({ 'text/uri-list': 'file:///tmp/test.md' }),
        'clipboard'
      )
    ).rejects.toThrow('File unavailable')
  })
})
