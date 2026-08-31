import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  hasWorkspacePathDragData,
  inspectNativeWorkspacePaths,
  fileUrlToPath,
  readClipboardFileUriPaths,
  readNativeClipboardWorkspacePaths,
  readNativeDroppedWorkspacePaths,
  readWorkspacePathDragData,
  resolveDataTransferWorkspacePaths,
  resolveStoredWorkspacePaths,
  WORKSPACE_PATH_DRAG_TYPE,
  writeWorkspacePathDragData,
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

  test('round trips internal workspace file tree drags', () => {
    const values = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => {
        values.set(type, value)
        if (!dataTransfer.types.includes(type)) dataTransfer.types.push(type)
      },
    } as unknown as DataTransfer

    writeWorkspacePathDragData(dataTransfer, [
      { path: '/workspace/project/notes.md', isDirectory: false },
    ])

    expect(dataTransfer.types).toContain(WORKSPACE_PATH_DRAG_TYPE)
    expect(hasWorkspacePathDragData(dataTransfer)).toBe(true)
    expect(readWorkspacePathDragData(dataTransfer)).toEqual([
      { path: '/workspace/project/notes.md', isDirectory: false },
    ])
  })

  test('resolves internal workspace file tree drags as path references', async () => {
    const dataTransfer = {
      types: [WORKSPACE_PATH_DRAG_TYPE],
      files: [] as unknown as FileList,
      getData: (type: string) =>
        type === WORKSPACE_PATH_DRAG_TYPE
          ? JSON.stringify([{ path: '/workspace/project/docs', isDirectory: true }])
          : '',
    } as unknown as DataTransfer

    await expect(resolveDataTransferWorkspacePaths(dataTransfer, 'drop', 'local')).resolves.toEqual(
      {
        attachmentFiles: [],
        referenceEntries: [{ path: '/workspace/project/docs', isDirectory: true }],
      }
    )
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

  test('asks Electron to inspect native clipboard paths with URI fallbacks', async () => {
    const data = clipboardData({
      'text/uri-list': 'file:///Users/alice/project/frontend',
    })
    mocks.desktopHost.mockResolvedValue([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])

    await expect(readNativeClipboardWorkspacePaths(data)).resolves.toEqual([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])
    expect(mocks.desktopHost).toHaveBeenCalledWith('clipboard.readWorkspacePaths', {
      fallbackPaths: ['/Users/alice/project/frontend'],
    })
  })

  test('asks Electron to inspect native dropped paths with URI fallbacks', async () => {
    const data = clipboardData({
      'text/uri-list': 'file:///Users/alice/project/frontend',
    })
    mocks.desktopHost.mockResolvedValue([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])

    await expect(readNativeDroppedWorkspacePaths(data)).resolves.toEqual([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])
    expect(mocks.desktopHost).toHaveBeenCalledWith('filesystem.inspectPaths', {
      paths: ['/Users/alice/project/frontend'],
    })
  })

  test('asks Electron to inspect pasted URI paths through declared host capabilities', async () => {
    const data = clipboardData({
      'text/uri-list': 'file:///Users/alice/project/frontend',
    })
    mocks.desktopHost.mockResolvedValue([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])

    await expect(readNativeClipboardWorkspacePaths(data)).resolves.toEqual([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])
    expect(mocks.desktopHost).toHaveBeenCalledWith('clipboard.readWorkspacePaths', {
      fallbackPaths: ['/Users/alice/project/frontend'],
    })
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

  test('inspects stored workspace paths without reading file bytes', async () => {
    mocks.desktopHost.mockResolvedValue([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])

    await expect(inspectNativeWorkspacePaths(['/Users/alice/project/frontend'])).resolves.toEqual([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])
    expect(mocks.desktopHost).toHaveBeenCalledWith('filesystem.inspectPaths', {
      paths: ['/Users/alice/project/frontend'],
    })
  })

  test('resolves ordinary local drops to path references through the shared entry point', async () => {
    const file = new File(['small context'], 'context.md', { type: 'text/markdown' })
    const data = clipboardData({ 'text/uri-list': 'file:///Users/alice/project/context.md' }, [
      file,
    ])
    mocks.desktopHost.mockResolvedValue([
      { path: '/Users/alice/project/context.md', isDirectory: false },
    ])

    await expect(resolveDataTransferWorkspacePaths(data, 'drop')).resolves.toEqual({
      attachmentFiles: [],
      referenceEntries: [{ path: '/Users/alice/project/context.md', isDirectory: false }],
    })
    expect(mocks.desktopHost).toHaveBeenCalledWith('filesystem.inspectPaths', {
      paths: ['/Users/alice/project/context.md'],
    })
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

  test('keeps pathless pasted images as attachments', async () => {
    const file = new File(['image'], 'clipboard.png', { type: 'image/png' })
    const data = clipboardData({}, [file])
    mocks.desktopHost.mockResolvedValue([])

    await expect(resolveDataTransferWorkspacePaths(data, 'clipboard')).resolves.toEqual({
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

  test('reads bytes only for image paths when resolving stored local paths', async () => {
    const image = new File(['image'], 'preview.png', { type: 'image/png' })
    mocks.desktopHost.mockResolvedValue([
      { path: '/Users/alice/project', isDirectory: true },
      { path: '/Users/alice/project/context.md', isDirectory: false },
      { path: '/Users/alice/project/preview.png', isDirectory: false },
    ])
    mocks.readDroppedFiles.mockResolvedValue([image])

    await expect(
      resolveStoredWorkspacePaths(
        [
          '/Users/alice/project',
          '/Users/alice/project/context.md',
          '/Users/alice/project/preview.png',
        ],
        false
      )
    ).resolves.toEqual({
      attachmentFiles: [image],
      referenceEntries: [
        { path: '/Users/alice/project', isDirectory: true },
        { path: '/Users/alice/project/context.md', isDirectory: false },
      ],
    })
    expect(mocks.readDroppedFiles).toHaveBeenCalledWith(['/Users/alice/project/preview.png'])
  })
})
