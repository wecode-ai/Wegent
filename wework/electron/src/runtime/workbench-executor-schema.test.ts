import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import {
  assertExecutorWorkbenchCompatibility,
  assertWorkbenchSchema,
} from './workbench-executor-schema.js'

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
  const binary = join(directory, 'executor')
  const interpreter = join(directory, 'node runtime')
  const script = join(directory, 'schema fixture.cjs')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await symlink(process.execPath, interpreter)
  // Kernel shebang parsing cannot quote an interpreter path containing spaces.
  await writeFile(
    binary,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(interpreter)} ${quote(script)} "$@"\n`
  )
  await writeFile(
    script,
    `if (process.argv.slice(2).join(' ') !== '--workbench-schema --version') process.exit(2);\n` +
      `if (process.env.WEGENT_AUTH_TOKEN || process.env.WEGENT_CODEX_HOME) process.exit(3);\n` +
      `process.stdout.write(${JSON.stringify(JSON.stringify(compatible))});\n`
  )
  await chmod(binary, 0o755)
  const probe = spawnSync(binary, ['--workbench-schema', '--version'], {
    env: {},
    encoding: 'utf8',
    timeout: 5_000,
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
})
