import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./run-with-resource-logging.mjs', import.meta.url))

function run(args, env = {}, preload) {
  const cwd = mkdtempSync(join(tmpdir(), 'runner-resource-test-'))
  try {
    if (preload) {
      const preloadPath = join(cwd, 'preload.mjs')
      writeFileSync(preloadPath, preload)
      env = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` }
    }
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 25_000,
      env: { ...process.env, ...env },
    })
    assert.ifError(result.error)
    const records = readFileSync(
      join(
        cwd,
        env.RUNNER_RESOURCE_LOG_PATH ?? 'wework/test-results/desktop-e2e/runner-resources.jsonl'
      ),
      'utf8'
    )
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    return { ...result, records }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('records periodic resources and preserves command arguments and failure exit', () => {
  const result = run([
    process.execPath,
    '-e',
    'console.log(process.argv[1]); setTimeout(() => process.exit(23), 16000)',
    'argument with spaces',
  ])
  assert.equal(result.status, 23)
  assert.match(result.stdout, /argument with spaces/)
  assert.deepEqual(
    result.records.map(record => record.phase),
    ['start', 'interval', 'end']
  )
  assert.equal(result.records.at(-1).exitCode, 23)
  const sample = result.records[1]
  assert.ok(sample.cpuCount > 0)
  assert.ok(sample.memoryTotalBytes > 0)
  assert.ok(sample.diskAvailableBytes >= 0)
  assert.ok(sample.cpuBusyPercent >= 0 && sample.cpuBusyPercent <= 100)
  if (process.platform === 'linux') {
    assert.match(sample.linux.memory, /MemAvailable:/)
    assert.ok(sample.linux.cgroupMemoryEvents)
  }
})

test('reports a command that cannot start and returns a failure', () => {
  const result = run(['/nonexistent/wework-resource-test-command'])
  assert.equal(result.status, 127)
  assert.match(result.stderr, /Command failed to start: ENOENT/)
  assert.deepEqual(
    result.records.map(record => record.phase),
    ['start', 'end']
  )
})

test('preserves child termination signals', () => {
  const result = run([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'])
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.records.at(-1).phase, 'end')
})

test('records process identities in a configurable artifact without command arguments', () => {
  const result = run([process.execPath, '-e', 'process.exit(0)', 'private-command-argument'], {
    RUNNER_PROCESS_DIAGNOSTICS: '1',
    RUNNER_RESOURCE_LOG_PATH: 'diagnostics/resources.jsonl',
  })
  assert.equal(result.status, 0)
  assert.ok(result.records.at(-1).commandPid > 0)
  for (const record of result.records) {
    assert.match(record.processes, /PID\s+PPID/)
    assert.doesNotMatch(record.processes, /private-command-argument/)
  }
})

for (const { name, output, directories } of [
  {
    name: 'partial',
    output: '8\tfixture cache\n',
    directories: [{ allocatedBytes: 8192, path: 'fixture cache' }],
  },
  { name: 'empty', output: '', directories: [] },
]) {
  test(`retains ${name} disk diagnostics without changing the child failure`, () => {
    const result = run(
      [process.execPath, '-e', 'process.exit(23)'],
      {},
      `
      import fs from 'node:fs'
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      const statfs = fs.statfsSync
      fs.statfsSync = path => ({ ...statfs(path), bavail: 0, ffree: 17 })
      childProcess.execFileSync = () => {
        const error = new Error('A directory disappeared during the scan')
        error.status = 1
        error.stdout = ${JSON.stringify(output)}
        throw error
      }
      Object.defineProperty(process, 'platform', { value: 'linux' })
      syncBuiltinESMExports()
    `
    )
    assert.equal(result.status, 23)
    assert.equal(result.records[0].diskAvailableInodes, 17)
    assert.deepEqual(result.records[0].diskUsage.directories, directories)
    assert.equal(result.records[0].diskUsage.incomplete.status, 1)
    assert.equal(result.records.at(-1).diskUsage, undefined)
    assert.equal(result.records.at(-1).exitCode, 23)
  })
}

for (const { remainingGiB, triggers } of [
  { remainingGiB: 73, triggers: ['growth'] },
  { remainingGiB: 1, triggers: ['low_free', 'growth'] },
]) {
  test(`captures disk growth once with ${remainingGiB} GiB remaining`, () => {
    const result = run(
      [process.execPath, '-e', 'process.exit(23)'],
      { WEWORK_E2E_PARALLEL_CHECKPOINTS: '4' },
      `
        import fs from 'node:fs'
        import childProcess from 'node:child_process'
        import { syncBuiltinESMExports } from 'node:module'
        const statfs = fs.statfsSync
        let samples = 0
        let scans = 0
        fs.statfsSync = path => {
          const current = statfs(path)
          const available = (samples++ === 0 ? 85 : ${remainingGiB}) * 1024 ** 3
          return { ...current, bavail: available / current.bsize }
        }
        childProcess.execFileSync = (_command, args) =>
          String(++scans) + '\\tdepth-' + args[3] + '\\n'
        Object.defineProperty(process, 'platform', { value: 'linux' })
        syncBuiltinESMExports()
      `
    )
    assert.equal(result.status, 23)
    assert.deepEqual(result.records[0].diskUsage.triggers, ['baseline'])
    assert.deepEqual(result.records[0].diskUsage.directories, [
      { allocatedBytes: 1024, path: 'depth-1' },
    ])
    const end = result.records.at(-1)
    assert.equal(end.diskInitialAvailableBytes, 85 * 1024 ** 3)
    assert.equal(end.diskAvailableBytes, remainingGiB * 1024 ** 3)
    assert.equal(end.diskAvailableDecreaseBytes, (85 - remainingGiB) * 1024 ** 3)
    assert.deepEqual(end.diskUsage.triggers, triggers)
    assert.deepEqual(end.diskUsage.directories, [{ allocatedBytes: 2048, path: 'depth-4' }])
    assert.equal(end.exitCode, 23)
  })
}
