import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { migrateCodexProviderState } from './codex-provider-upgrade.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const { testNodeEnvironment } = await import('./test-helpers.js')
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: (
      command: string,
      args: string[],
      options: import('node:child_process').ExecFileOptions
    ) =>
      promisify(original.execFile)(process.execPath, [command, ...args], {
        ...options,
        env: testNodeEnvironment(options.env),
      }),
  })
  return { ...original, execFile }
})

const directories: string[] = []
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex provider upgrade '))
  directories.push(root)
  const command = join(root, 'executor.cjs')
  return {
    command,
    options: {
      dataDirectory: join(root, 'desktop'),
      environment: {
        WEWORK_EXECUTOR_PATH: command,
        WEGENT_CODEX_HOME: join(root, 'codex'),
        WEGENT_WORKBENCH_HOME: join(root, 'workbench'),
        OPENAI_API_KEY: 'synthetic-not-forwarded',
        AUTH_TOKEN: 'synthetic-not-forwarded',
        CODEX_HOME: '/must-not-inherit',
      },
    },
  }
}

test('uses the selected executor offline entry without inheriting account or task credentials', async () => {
  const { command, options } = await fixture()
  const args = [
    '--workbench-codex-providers-migrate',
    JSON.stringify({
      codex_home: options.environment.WEGENT_CODEX_HOME,
      agents_root: join(options.environment.WEGENT_WORKBENCH_HOME, 'agents'),
    }),
    '--executor-stopped',
    '--version',
  ]
  await writeFile(
    command,
    `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))}) process.exit(2)
    if (process.env.OPENAI_API_KEY || process.env.AUTH_TOKEN || process.env.CODEX_HOME) process.exit(3)
    process.stdout.write(JSON.stringify({codex_provider_migration:1,complete:true,checked_homes:2}))
    `
  )
  await expect(migrateCodexProviderState(options)).resolves.toBeUndefined()
})

test('rejects legacy and incomplete responses without exposing child diagnostics', async () => {
  const { command, options } = await fixture()
  for (const response of [
    'wegent-executor 0.0.1',
    JSON.stringify({ codex_provider_migration: 1, complete: false }),
    JSON.stringify({ codex_provider_migration: 2, complete: true }),
    JSON.stringify({ secret: 'synthetic-private-history' }),
  ]) {
    await writeFile(command, `process.stdout.write(${JSON.stringify(response)})`)
    await expect(migrateCodexProviderState(options)).rejects.toThrow(/Codex|executor/)
    await expect(migrateCodexProviderState(options)).rejects.not.toThrow(
      'synthetic-private-history'
    )
  }
})

test('an interrupted offline command can complete on the next start', async () => {
  const { command, options } = await fixture()
  await writeFile(command, "process.stderr.write('synthetic-private-history'); process.exit(5)")
  await expect(migrateCodexProviderState(options)).rejects.toThrow('journal will resume')
  await expect(migrateCodexProviderState(options)).rejects.not.toThrow('synthetic-private-history')
  await writeFile(
    command,
    'process.stdout.write(JSON.stringify({codex_provider_migration:1,complete:true}))'
  )
  await expect(migrateCodexProviderState(options)).resolves.toBeUndefined()
})
