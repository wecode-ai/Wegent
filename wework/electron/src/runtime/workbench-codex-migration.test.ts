import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { assertCodexHomeCanMove } from './workbench-codex-migration.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

test('checks the exact Home without passing credentials or accepting legacy version output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex move check '))
  directories.push(root)
  const binary = join(root, 'executor')
  const script = join(root, 'probe.cjs')
  const home = join(root, 'codex home')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(
    binary,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`
  )
  await chmod(binary, 0o755)
  await writeFile(
    script,
    `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['--workbench-codex-migration-check', home, '--version']))}) process.exit(2)
    if (process.env.WEGENT_AUTH_TOKEN || process.env.CODEX_HOME) process.exit(3)
    process.stdout.write(JSON.stringify({codex_home_migration: 1, allowed: true}))
  `
  )
  vi.stubEnv('WEGENT_AUTH_TOKEN', 'synthetic-not-forwarded')
  vi.stubEnv('CODEX_HOME', '/must-not-inherit')
  await expect(assertCodexHomeCanMove(binary, home)).resolves.toBeUndefined()
  for (const response of [
    null,
    {},
    { codex_home_migration: 2, allowed: true },
    { codex_home_migration: 1, allowed: false, reason: 'synthetic-secret' },
  ]) {
    await writeFile(script, `process.stdout.write(${JSON.stringify(JSON.stringify(response))})`)
    await expect(assertCodexHomeCanMove(binary, home)).rejects.toThrow(/Codex/)
    await expect(assertCodexHomeCanMove(binary, home)).rejects.not.toThrow('synthetic-secret')
  }
  await writeFile(script, "process.stdout.write('executor 0.0.1')")
  await expect(assertCodexHomeCanMove(binary, home)).rejects.toThrow('verification failed')
})
