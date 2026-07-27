import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  inspectNativeWorkspacePaths,
  readClipboardFileUriPaths,
  readNativeClipboardWorkspacePaths,
  readNativeDroppedWorkspacePaths,
  resolveDataTransferWorkspacePaths,
  resolveStoredWorkspacePaths,
} from './workspace-path-transfer'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readDroppedFiles: vi.fn(),
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

vi.mock('@/tauri/droppedFiles', () => ({
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
    mocks.invoke.mockReset()
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

  test('asks Tauri to inspect native clipboard paths with URI fallbacks', async () => {
    const data = clipboardData({
      'text/uri-list': 'file:///Users/alice/project/frontend',
    })
    mocks.invoke.mockResolvedValue([{ path: '/Users/alice/project/frontend', isDirectory: true }])

    await expect(readNativeClipboardWorkspacePaths(data)).resolves.toEqual([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])
    expect(mocks.invoke).toHaveBeenCalledWith('read_clipboard_workspace_paths', {
      fallbackPaths: ['/Users/alice/project/frontend'],
    })
  })

  test('asks Tauri to inspect native dropped paths with URI fallbacks', async () => {
    const data = clipboardData({
      'text/uri-list': 'file:///Users/alice/project/frontend',
    })
    mocks.invoke.mockResolvedValue([{ path: '/Users/alice/project/frontend', isDirectory: true }])

    await expect(readNativeDroppedWorkspacePaths(data)).resolves.toEqual([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])
    expect(mocks.invoke).toHaveBeenCalledWith('read_dropped_workspace_paths', {
      fallbackPaths: ['/Users/alice/project/frontend'],
    })
  })

  test('inspects stored workspace paths without reading file bytes', async () => {
    mocks.invoke.mockResolvedValue([{ path: '/Users/alice/project/frontend', isDirectory: true }])

    await expect(inspectNativeWorkspacePaths(['/Users/alice/project/frontend'])).resolves.toEqual([
      { path: '/Users/alice/project/frontend', isDirectory: true },
    ])
    expect(mocks.invoke).toHaveBeenCalledWith('inspect_workspace_paths', {
      paths: ['/Users/alice/project/frontend'],
    })
  })

  test('resolves ordinary local drops to path references through the shared entry point', async () => {
    const file = new File(['small context'], 'context.md', { type: 'text/markdown' })
    const data = clipboardData({ 'text/uri-list': 'file:///Users/alice/project/context.md' }, [
      file,
    ])
    mocks.invoke.mockResolvedValue([
      { path: '/Users/alice/project/context.md', isDirectory: false },
    ])

    await expect(resolveDataTransferWorkspacePaths(data, 'drop', 'local')).resolves.toEqual({
      attachmentFiles: [],
      referenceEntries: [{ path: '/Users/alice/project/context.md', isDirectory: false }],
    })
    expect(mocks.invoke).toHaveBeenCalledWith('read_dropped_workspace_paths', {
      fallbackPaths: ['/Users/alice/project/context.md'],
    })
  })

  test('keeps pasted files as attachments when no native path can be resolved', async () => {
    const file = new File(['archive'], 'feedback.zip', { type: 'application/zip' })
    const data = clipboardData({}, [file])
    mocks.invoke.mockResolvedValue([])

    await expect(resolveDataTransferWorkspacePaths(data, 'clipboard', 'local')).resolves.toEqual({
      attachmentFiles: [file],
      referenceEntries: [],
    })
    expect(mocks.invoke).toHaveBeenCalledWith('read_clipboard_workspace_paths', {
      fallbackPaths: [],
    })
  })

  test('reads bytes only for image paths when resolving stored local paths', async () => {
    const image = new File(['image'], 'preview.png', { type: 'image/png' })
    mocks.invoke.mockResolvedValue([
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
