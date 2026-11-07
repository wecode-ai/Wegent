import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { createClaudeCliAlias } from '../e2e/desktop/modules/local-harness-cli.mjs'

test.each(['claude.exe', 'renamed-native.exe'])(
  'Windows Claude override exposes the package-declared %s to the existing shim resolver',
  async executable => {
    const root = await mkdtemp(join(tmpdir(), 'claude alias '))
    try {
      const bin = join(root, 'node_modules/.bin')
      const native = join(root, 'node_modules/@anthropic-ai/claude-code/bin')
      await mkdir(bin, { recursive: true })
      await mkdir(native, { recursive: true })
      await writeFile(join(bin, 'claude.cmd'), '@echo off\r\ncall another.cmd %*\r\n')
      const bytes = Buffer.from('MZ native Claude fixture')
      await writeFile(join(native, executable), bytes)
      await writeFile(
        join(native, '../package.json'),
        JSON.stringify({ bin: { claude: `bin/${executable}` } })
      )
      await writeFile(join(root, 'local-claude.cmd'), 'obsolete alias')
      const alias = await createClaudeCliAlias(bin, root, 'win32')
      expect(basename(alias)).toBe('local-claude.cmd')
      expect(await readFile(alias, 'utf8')).toBe(
        `@echo off\r\n"${join(native, executable)}" %*\r\n`
      )
      expect(await readFile(alias, 'utf8')).not.toContain('call ')
      expect(await readFile(join(native, executable))).toEqual(bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('Unix Claude override retains the real CLI symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-alias-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'claude'), 'native Claude fixture')
    const alias = await createClaudeCliAlias(bin, root, 'linux')
    expect(await readlink(alias)).toBe(join(bin, 'claude'))
    expect(await readFile(alias, 'utf8')).toBe('native Claude fixture')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
