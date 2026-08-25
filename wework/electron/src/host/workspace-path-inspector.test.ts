import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  extractFilePathsFromNativePayloads,
  inspectWorkspacePaths,
} from './workspace-path-inspector.js'

describe('workspace path inspector', () => {
  test('extracts file URLs and native plist strings without duplicates', () => {
    expect(
      extractFilePathsFromNativePayloads([
        'file:///Users/alice/My%20Project\r\nfile:///Users/alice/README.md',
        '<plist><array><string>file:///Users/alice/My%20Project</string></array></plist>',
      ])
    ).toEqual(['/Users/alice/My Project', '/Users/alice/README.md'])
  })

  test('keeps existing files and folders in input order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-workspace-paths-'))
    const folder = join(root, 'folder')
    const file = join(root, 'README.md')
    await mkdir(folder)
    await writeFile(file, 'context')

    await expect(inspectWorkspacePaths([folder, '/missing', file, folder])).resolves.toEqual([
      { path: folder, isDirectory: true },
      { path: file, isDirectory: false },
    ])
  })
})
