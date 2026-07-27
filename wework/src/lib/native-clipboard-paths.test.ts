import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  readClipboardFileUriPaths,
  readNativeClipboardWorkspacePaths,
} from './native-clipboard-paths'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

function clipboardData(values: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => values[type] ?? '',
  } as DataTransfer
}

describe('native clipboard paths', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
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
})
