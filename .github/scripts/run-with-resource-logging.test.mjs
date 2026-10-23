import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./run-with-resource-logging.mjs', import.meta.url))

function run(args, env = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'runner-resource-test-'))
  try {
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
