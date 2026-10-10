import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { executorMigrationLock } from './workbench-migration-lock.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture(script: (directory: string) => string) {
  const directory = await mkdtemp(join(tmpdir(), 'migration lock client '))
  directories.push(directory)
  const source = join(directory, 'fixture.cjs')
  const binary = join(directory, 'executor')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(source, script(directory))
  await writeFile(
    binary,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`
  )
  await chmod(binary, 0o755)
  return { directory, binary }
}

test('holds the child pipe until release and uses exact resource file locks', async () => {
  const { directory, binary } = await fixture(
    root => `
    const fs = require('node:fs');
    if (process.argv[2] !== '--workbench-lock' || process.argv[4] !== '--version') process.exit(2);
    fs.writeFileSync(${JSON.stringify(join(root, 'requested.json'))}, process.argv[3]);
    process.stdout.write('{"protocol_version":1,"locked":true}\\n');
    process.stdin.resume();
    process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(join(root, 'released'))}, 'yes'));
  `
  )
  const lock = await executorMigrationLock(binary)([
    join(directory, 'source'),
    join(directory, 'target'),
  ])
  try {
    lock.assertHeld()
    expect(JSON.parse(await readFile(join(directory, 'requested.json'), 'utf8'))).toEqual([
      join(directory, '.wework-home-migration-source.lock'),
      join(directory, '.wework-home-migration-target.lock'),
    ])
  } finally {
    await lock.release()
  }
  expect(await readFile(join(directory, 'released'), 'utf8')).toBe('yes')
  expect(() => lock.assertHeld()).toThrow('exited unexpectedly')
})

test.each([
  `process.stdout.write('0.0.1\\n')`,
  `process.stderr.write('synthetic-private-diagnostic'); process.exit(1)`,
  `process.stdout.write('{"protocol_version":2,"locked":true}\\n'); process.stdin.resume()`,
])('rejects unsupported or failed lock children without leaking their output', async script => {
  const { directory, binary } = await fixture(() => script)
  await expect(executorMigrationLock(binary)([join(directory, 'source')])).rejects.toThrow(
    /^Workbench Home migration lock unavailable$/
  )
})
