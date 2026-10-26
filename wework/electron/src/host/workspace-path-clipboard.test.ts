import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readClipboardWorkspacePaths } from './workspace-path-clipboard.js'

const nativeClipboard = vi.hoisted(() => ({
  availableFormats: vi.fn(() => [] as string[]),
  readBuffer: vi.fn<(format: string) => Buffer>(() => Buffer.alloc(0)),
}))

vi.mock('electron', () => ({ clipboard: nativeClipboard }))

describe('Electron 43 workspace path clipboard', () => {
  let root: string
  let file: string
  let folder: string

  beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), 'wework-clipboard-'))
    folder = join(root, 'Project & context')
    file = join(root, '粘贴 context.md')
    await mkdir(folder)
    await writeFile(file, 'context')
  })

  afterEach(async () => {
    await rm(root, { recursive: true })
  })

  test('reads synchronous URI and plist formats, deduplicates and rejects stale paths', async () => {
    nativeClipboard.availableFormats.mockReturnValue([
      'text/plain',
      'text/uri-list',
      'NSFilenamesPboardType',
    ])
    nativeClipboard.readBuffer.mockImplementation(format =>
      Buffer.from(
        format === 'text/uri-list'
          ? `${pathToFileURL(file).href}\r\n${pathToFileURL(join(root, 'missing')).href}`
          : `<plist><array><string>${folder.replaceAll('&', '&amp;')}</string></array></plist>`
      )
    )

    await expect(readClipboardWorkspacePaths([file, root])).resolves.toEqual([
      { path: file, isDirectory: false },
      { path: folder, isDirectory: true },
      { path: root, isDirectory: true },
    ])
    expect(nativeClipboard.readBuffer).not.toHaveBeenCalledWith('text/plain')
    expect(nativeClipboard.readBuffer).toHaveBeenCalledWith('text/uri-list')
  })

  test.each([
    ['public.file-url', 'utf8'],
    ['FileNameW', 'utf16le'],
  ] as const)('reads a %s buffer using its native encoding', async (format, encoding) => {
    nativeClipboard.availableFormats.mockReturnValue([format])
    const value = encoding === 'utf8' ? pathToFileURL(file).href : file
    nativeClipboard.readBuffer.mockReturnValue(Buffer.from(`${value}\0`, encoding))

    await expect(readClipboardWorkspacePaths([])).resolves.toEqual([
      { path: file, isDirectory: false },
    ])
  })

  test('continues when one format disappears during a read', async () => {
    nativeClipboard.availableFormats.mockReturnValue(['public.file-url', 'text/uri-list'])
    nativeClipboard.readBuffer.mockImplementation(format => {
      if (format === 'public.file-url') throw new Error('Format disappeared')
      return Buffer.from(pathToFileURL(folder).href)
    })

    await expect(readClipboardWorkspacePaths([])).resolves.toEqual([
      { path: folder, isDirectory: true },
    ])
  })

  test('inspects renderer paths when native format enumeration fails', async () => {
    nativeClipboard.availableFormats.mockImplementation(() => {
      throw new Error('Clipboard unavailable')
    })

    await expect(readClipboardWorkspacePaths([folder, join(root, 'missing')])).resolves.toEqual([
      { path: folder, isDirectory: true },
    ])
  })
})
