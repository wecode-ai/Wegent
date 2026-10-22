import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { assertCodexHomeCanMove } from './workbench-codex-migration.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: (
      command: string,
      args: string[],
      options: import('node:child_process').ExecFileOptions
    ) => promisify(original.execFile)(process.execPath, [command, ...args], options),
  })
  return { ...original, execFile }
})

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

test('checks the exact Home without passing credentials or accepting legacy version output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex move check '))
  directories.push(root)
  const script = join(root, 'probe.cjs')
  const binary = script
  const home = join(root, 'codex home')
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
