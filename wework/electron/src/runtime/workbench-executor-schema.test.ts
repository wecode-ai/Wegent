import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { hashComponentFileContents } from './component-content-hash.js'
import * as componentHash from './component-content-hash.js'

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
  vi.restoreAllMocks()
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

test('packaged schema authorizes only its exact binary and detects later replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'packaged schema '))
  directories.push(directory)
  const binary = join(directory, 'executor')
  // This file cannot execute: only a verified build-time handshake may authorize it.
  await writeFile(binary, 'packaged-native-executor')
  const environment = { WEWORK_EXECUTOR_PATH: binary }
  const proof = { sha256: await hashComponentFileContents(binary), response: compatible }
  await expect(assertExecutorWorkbenchCompatibility(environment, proof)).resolves.toBeUndefined()
  await expect(assertExecutorWorkbenchCompatibility(environment)).resolves.toBeUndefined()
  await writeFile(binary, 'replaced-executor')
  await expect(assertExecutorWorkbenchCompatibility(environment)).rejects.toThrow(
    'checksum mismatch'
  )
  await expect(
    assertExecutorWorkbenchCompatibility(environment, { ...proof, response: {} })
  ).rejects.toThrow('cannot read and write')
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

test('validates a matching override candidate with one fresh binary hash per preflight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate schema '))
  directories.push(directory)
  const binary = join(directory, 'executor')
  await writeFile(binary, 'candidate-native-executor')
  const candidateSchema = { sha256: await hashComponentFileContents(binary), response: compatible }
  const hash = vi.spyOn(componentHash, 'hashComponentFileContents')
  const environment = { WEWORK_EXECUTOR_PATH: binary }

  await expect(
    assertExecutorWorkbenchCompatibility(environment, undefined, { candidateSchema })
  ).resolves.toBeUndefined()
  expect(hash).toHaveBeenCalledTimes(1)
  await expect(assertExecutorWorkbenchCompatibility(environment)).resolves.toBeUndefined()
  expect(hash).toHaveBeenCalledTimes(2)
  await writeFile(binary, 'replaced-executor')
  await expect(
    assertExecutorWorkbenchCompatibility(environment, undefined, { candidateSchema })
  ).rejects.toThrow('checksum mismatch')
  expect(hash).toHaveBeenCalledTimes(3)
})

test('queries the real override when candidate bytes differ without forwarding credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'override schema '))
  directories.push(directory)
  const binary = join(directory, 'override.cjs')
  await writeFile(
    binary,
    `if (process.argv.slice(2).join(' ') !== '--workbench-schema --version') process.exit(2);\n` +
      `if (process.env.WEGENT_AUTH_TOKEN || process.env.WEGENT_CODEX_HOME) process.exit(3);\n` +
      `process.stdout.write(${JSON.stringify(JSON.stringify(compatible))});\n`
  )
  const hash = vi.spyOn(componentHash, 'hashComponentFileContents')
  const environment = { WEWORK_EXECUTOR_PATH: binary, WEGENT_AUTH_TOKEN: 'synthetic-not-forwarded' }
  const candidateSchema = { sha256: 'different-binary-digest', response: {} }

  await expect(
    assertExecutorWorkbenchCompatibility(environment, undefined, { candidateSchema })
  ).resolves.toBeUndefined()
  expect(hash).toHaveBeenCalledTimes(1)
  await writeFile(
    binary,
    `process.stdout.write(${JSON.stringify(JSON.stringify({ ...compatible, protocol_version: 2 }))});\n`
  )
  await expect(
    assertExecutorWorkbenchCompatibility(environment, undefined, { candidateSchema })
  ).rejects.toThrow('cannot read and write')
  expect(hash).toHaveBeenCalledTimes(2)
})
