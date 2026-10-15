import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import {
  EXECUTOR_SCHEMA_QUERY_TIMEOUT_MS,
  assertExecutorWorkbenchCompatibility,
  assertWorkbenchSchema,
} from './workbench-executor-schema.js'

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
  return {
    ...original,
    execFile,
    spawnSync: (
      command: string,
      args: string[],
      options: import('node:child_process').SpawnSyncOptions
    ) => original.spawnSync(process.execPath, [command, ...args], options),
  }
})

const compatible = {
  protocol_version: 1,
  workbench_layout_versions: [1],
  capability_manifest_versions: [2],
}
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

test.each([
  null,
  '1.0.0',
  {},
  { ...compatible, protocol_version: 2 },
  { ...compatible, workbench_layout_versions: [2] },
  { ...compatible, capability_manifest_versions: [1] },
  { ...compatible, capability_manifest_versions: ['2'] },
])('rejects missing or incompatible schema %j', schema => {
  expect(() => assertWorkbenchSchema(schema)).toThrow()
})

test('allows explicitly supported layout and manifest versions', () => {
  expect(() => assertWorkbenchSchema(compatible)).not.toThrow()
  expect(() =>
    assertWorkbenchSchema({ ...compatible, capability_manifest_versions: [1, 2, 3] })
  ).not.toThrow()
})

test('allows time for first-run macOS executable validation', () => {
  expect(EXECUTOR_SCHEMA_QUERY_TIMEOUT_MS).toBeGreaterThan(5_000)
})

test('missing executors and arbitrary wrapper arguments cannot authorize migration', async () => {
  await expect(assertExecutorWorkbenchCompatibility({})).rejects.toThrow('before Home migration')
  await expect(
    assertExecutorWorkbenchCompatibility({
      WEWORK_EXECUTOR_PATH: '/missing',
      WEWORK_EXECUTOR_ARGS_JSON: '["--upgrade"]',
    })
  ).rejects.toThrow('wrapper arguments')
  await expect(
    assertExecutorWorkbenchCompatibility({ WEWORK_EXECUTOR_PATH: '/missing' })
  ).rejects.toThrow('schema query failed')
})

test('query supports spaced paths, carries the legacy version guard and strips credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench schema '))
  directories.push(directory)
  const script = join(directory, 'schema fixture.cjs')
  const binary = script
  await writeFile(
    script,
    `if (process.argv.slice(2).join(' ') !== '--workbench-schema --version') process.exit(2);\n` +
      `if (process.env.WEGENT_AUTH_TOKEN || process.env.WEGENT_CODEX_HOME) process.exit(3);\n` +
      `process.stdout.write(${JSON.stringify(JSON.stringify(compatible))});\n`
  )
  const probe = spawnSync(binary, ['--workbench-schema', '--version'], {
    env: {},
    encoding: 'utf8',
    timeout: EXECUTOR_SCHEMA_QUERY_TIMEOUT_MS,
  })
  expect(
    probe.status,
    JSON.stringify({ error: probe.error?.message, signal: probe.signal, stderr: probe.stderr })
  ).toBe(0)
  await expect(
    assertExecutorWorkbenchCompatibility({
      WEWORK_EXECUTOR_PATH: binary,
      WEGENT_AUTH_TOKEN: 'synthetic-not-forwarded',
      WEGENT_CODEX_HOME: join(directory, 'must-not-touch'),
    })
  ).resolves.toBeUndefined()
  await writeFile(script, `process.stdout.write('0.0.1');\n`)
  await expect(
    assertExecutorWorkbenchCompatibility({ WEWORK_EXECUTOR_PATH: binary })
  ).rejects.toThrow('schema query failed')
}, 20_000)

test('failed schema probes record exit metadata without child output or environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench schema failure '))
  directories.push(directory)
  const script = join(directory, 'failure.cjs')
  await writeFile(script, "process.stderr.write('private-child-diagnostics'); process.exit(7)\n")
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      assertExecutorWorkbenchCompatibility({ WEWORK_EXECUTOR_PATH: script })
    ).rejects.toThrow('schema query failed')
    expect(diagnostic).toHaveBeenCalledWith(
      '[executor-schema] query failed',
      expect.objectContaining({ code: 7, signal: null, killed: false })
    )
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-child-diagnostics')
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(script)
  } finally {
    diagnostic.mockRestore()
  }
})
