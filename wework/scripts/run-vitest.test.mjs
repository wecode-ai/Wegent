import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile } from 'vite'

import { wrapWindowsScriptCommand } from './child-process-command.mjs'
import { discoverNodeTestFiles, discoverTestFiles } from './lib/test-files.mjs'
import { createTestCommandPlan, runTestCommands } from './lib/test-runner.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

function previousTestDiscovery(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return previousTestDiscovery(path)
      return entry.isFile() && entry.name.endsWith('.test.mjs')
        ? [relative(root, path).replaceAll('\\', '/')]
        : []
    })
    .sort()
}

test('the compact scripts suite covers every previous hook file with the same test engine', async t => {
  const previous = previousTestDiscovery(join(root, 'scripts'))
  const previousNodeTests = previous.filter(path =>
    readFileSync(join(root, path), 'utf8').includes("from 'node:test'")
  )
  assert.deepEqual(discoverTestFiles(root, ['scripts']), previous)
  assert.deepEqual(discoverNodeTestFiles(root, ['scripts']), previousNodeTests)

  const commands = createTestCommandPlan(root, ['--suite=scripts'])
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[0], {
    command: 'vitest',
    args: ['run', '--config', 'vitest.scripts.config.ts'],
  })
  assert.deepEqual(commands[1], {
    command: process.execPath,
    args: ['--test', ...previousNodeTests],
  })
  const config = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    join(root, 'vitest.scripts.config.ts'),
    root
  )
  assert.ok(config)
  assert.deepEqual(config.config.test.include, ['scripts/**/*.test.mjs'])
  assert.equal(config.config.test.maxWorkers, 2)
  const vitestFiles = previous.filter(path => !config.config.test.exclude.includes(path))
  assert.deepEqual(
    vitestFiles,
    previous.filter(path => !previousNodeTests.includes(path))
  )
  assert.equal(new Set([...vitestFiles, ...previousNodeTests]).size, previous.length)
  t.diagnostic(
    `${previous.length} script files retain coverage; ${vitestFiles.length} Vitest and ${previousNodeTests.length} Node`
  )

  const windowsCommand = wrapWindowsScriptCommand('vitest.cmd', commands[0].args, {
    platform: 'win32',
  })
  assert.ok([windowsCommand.command, ...windowsCommand.args].join(' ').length < 8191)
  assert.ok([process.execPath, ...commands[1].args].join(' ').length < 32767)
  assert.ok(!commands[0].args.includes('--exclude'))
  const hook = readFileSync(resolve(root, '../scripts/hooks/ai-push-gate.sh'), 'utf8')
  assert.match(hook, /pnpm --filter wework test --suite=scripts/)
  assert.ok(!hook.includes('SCRIPT_TEST_FILES'))
})

test('default and focused commands preserve every engine without expanding exclusions on the command line', async () => {
  const allNodeTests = [
    ...previousTestDiscovery(join(root, 'dsh')),
    ...previousTestDiscovery(join(root, 'scripts')),
  ]
    .filter(path => readFileSync(join(root, path), 'utf8').includes("from 'node:test'"))
    .sort()
  const commands = createTestCommandPlan(root, [])
  assert.deepEqual(
    commands.map(item => item.command),
    [process.execPath, 'vitest', 'vitest', 'pnpm', process.execPath]
  )
  assert.deepEqual(commands[0].args, ['scripts/dev-executor-reload.integration.mjs'])
  assert.deepEqual(commands[3].args, ['--dir', 'electron', 'test'])
  assert.deepEqual(commands[4].args, ['--test', ...allNodeTests])
  assert.deepEqual(commands[1].args, ['run', '--exclude', 'scripts/**'])
  assert.deepEqual(commands[2].args, ['run', '--config', 'vitest.scripts.config.ts'])
  const config = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    join(root, 'vitest.config.ts'),
    root
  )
  assert.ok(config)
  for (const path of allNodeTests.filter(path => path.startsWith('scripts/'))) {
    assert.ok(config.config.test.exclude.includes(path), `${path} must remain excluded from Vitest`)
  }
  assert.ok(config.config.test.exclude.includes('dsh/**/*.test.mjs'))

  const script = previousTestDiscovery(join(root, 'scripts')).find(
    path => !allNodeTests.includes(path)
  )
  const focused = createTestCommandPlan(root, [
    'src/fixture.test.ts',
    script,
    allNodeTests[0],
    '--maxWorkers',
    '1',
  ])
  assert.deepEqual(focused, [
    {
      command: 'vitest',
      args: ['run', '--exclude', 'scripts/**', 'src/fixture.test.ts', '--maxWorkers', '1'],
    },
    {
      command: 'vitest',
      args: ['run', '--config', 'vitest.scripts.config.ts', script, '--maxWorkers', '1'],
    },
    { command: process.execPath, args: ['--test', allNodeTests[0]] },
  ])
})

test('unknown, incomplete and duplicate suites fail before executing tests', () => {
  for (const args of [['--suite=unknown'], ['--suite'], ['--suite=scripts', '--suite=scripts']]) {
    assert.throws(() => createTestCommandPlan(root, args), /Unknown test suite/)
  }
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/run-vitest.mjs'), '--suite=unknown'],
    {
      cwd: root,
      encoding: 'utf8',
    }
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown test suite: --suite=unknown/)
})

test('Node concurrency keeps its default unless the existing local worker override is explicit', () => {
  const defaults = createTestCommandPlan(root, ['--suite=scripts'])
  assert.ok(!defaults[1].args.some(argument => argument.startsWith('--test-concurrency')))
  const configured = createTestCommandPlan(root, ['--suite=scripts'], { nodeTestWorkers: '2' })
  assert.deepEqual(configured[1].args, [
    '--test',
    '--test-concurrency=2',
    ...defaults[1].args.slice(1),
  ])
  for (const nodeTestWorkers of ['', '0', '-1', '1.5', 'two', 'Infinity']) {
    assert.throws(
      () => createTestCommandPlan(root, ['--suite=scripts'], { nodeTestWorkers }),
      /positive integer/
    )
  }
})

test('a failing child preserves its exit code and stops later test engines', t => {
  const directory = mkdtempSync(join(tmpdir(), 'wework-test-runner-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const marker = join(directory, 'executed.txt')
  const result = runTestCommands(
    [
      {
        command: process.execPath,
        args: [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], 'first'); process.exit(37)",
          marker,
        ],
      },
      {
        command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'second')", marker],
      },
    ],
    root
  )
  assert.deepEqual(result, { status: 37 })
  assert.equal(readFileSync(marker, 'utf8'), 'first')
  assert.throws(
    () => runTestCommands([{ command: join(directory, 'missing.exe'), args: [] }], root),
    { code: 'ENOENT' }
  )
})
