/** @jest-environment node */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseUnifiedDiff } from '@wegent/collaboration/conversation/parseUnifiedDiff'

function createGitPatches() {
  const directory = mkdtempSync(join(tmpdir(), 'wegent-diff-paths-'))
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
        ),
        NODE_ENV: process.env.NODE_ENV,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    })
  const paths = [
    'dir b/file.txt',
    'dir b/中文 "quoted".ts',
    'nested folder b/inner b/file.txt',
    'nested folder/中文文件.ts',
    'nested folder/emoji-🙂.ts',
    'nested folder/a"quoted".ts',
    'nested folder/back\\slash.ts',
    'nested folder/tab\tnewline\n.ts',
    'nested folder/plain space.ts',
  ]
  const createdPaths = ['dir b/new file.txt', 'dir b/新建 "quoted".ts', 'dir b/empty new.txt']
  const deletedPaths = ['dir b/deleted file.txt', 'dir b/删除 "quoted".ts', 'dir b/empty old.txt']
  const renames = [
    { from: 'dir b/source file.txt', to: 'dir b/renamed file.txt' },
    { from: 'nested folder/source"中文.ts', to: 'nested folder/renamed"文件.ts' },
  ]
  const binaryPath = 'dir b/binary file.bin'
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
  }

  try {
    git(['init', '--initial-branch=main'])
    expect(realpathSync(git(['rev-parse', '--show-toplevel']).trim())).toBe(realpathSync(directory))
    for (const path of paths) {
      write(path, path === 'dir b/file.txt' ? '-- a/metadata-decoy.txt\nbefore\n' : 'before\n')
    }
    for (const path of deletedPaths) write(path, path.includes('empty') ? '' : 'removed\n')
    for (const rename of renames) write(rename.from, `rename ${rename.from}\n`)
    write(binaryPath, Buffer.from([0, 1, 2]))
    git(['add', '.'])
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'baseline'])
    for (const path of paths) {
      write(path, path === 'dir b/file.txt' ? '++ b/metadata-decoy.txt\nafter\n' : 'after\n')
    }
    for (const path of createdPaths) write(path, path.includes('empty') ? '' : 'created\n')
    for (const path of deletedPaths) rmSync(join(directory, path))
    for (const rename of renames) git(['mv', '--', rename.from, rename.to])
    write(binaryPath, Buffer.from([0, 3, 4]))
    git(['add', '.'])
    // Keep empty additions/deletions distinct while retaining the real rename cases.
    const patches = [true, false].map(quotePaths =>
      git([
        '-c',
        `core.quotePath=${quotePaths}`,
        'diff',
        '--cached',
        '--find-renames',
        '--no-rename-empty',
        'HEAD',
      ])
    )
    return { paths, createdPaths, deletedPaths, renames, binaryPath, patches }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Git diff file paths', () => {
  it.each([true, false])('matches real filenames with core.quotePath=%s', quotePaths => {
    const { paths, createdPaths, deletedPaths, renames, binaryPath, patches } = createGitPatches()
    const diff = patches[quotePaths ? 0 : 1]
    const sections = parseUnifiedDiff(diff)

    expect(sections.map(section => section.path).sort()).toEqual(
      [
        ...paths,
        ...createdPaths,
        ...deletedPaths,
        ...renames.map(rename => rename.to),
        binaryPath,
      ].sort()
    )
    for (const path of paths) {
      const section = sections.find(section => section.path === path)
      expect(section?.oldPath).toBe(path)
      expect(section?.lines).toContain('-before')
      expect(section?.lines).toContain('+after')
    }
    for (const path of createdPaths) {
      const section = sections.find(section => section.path === path)
      expect(section?.oldPath).toBeUndefined()
      if (!path.includes('empty')) expect(section?.lines).toContain('+created')
    }
    for (const path of deletedPaths) {
      const section = sections.find(section => section.path === path)
      expect(section?.oldPath).toBe(path)
      if (!path.includes('empty')) expect(section?.lines).toContain('-removed')
    }
    for (const rename of renames) {
      expect(sections.find(section => section.path === rename.to)?.oldPath).toBe(rename.from)
    }
    expect(sections.find(section => section.path === binaryPath)?.oldPath).toBe(binaryPath)

    // Different legal quoting of the same paths must still merge into one file section.
    const merged = parseUnifiedDiff(patches.join('\n'))
    expect(merged.map(section => section.path)).toEqual(sections.map(section => section.path))
    for (const section of merged) {
      expect(section.lines.filter(line => line.startsWith('diff --git '))).toHaveLength(2)
    }
  })
})
