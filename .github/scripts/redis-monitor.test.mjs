import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./run-with-redis-monitor.sh', import.meta.url))

function capture(monitor, command) {
  const root = mkdtempSync(join(tmpdir(), 'redis-monitor-test-'))
  try {
    writeFileSync(join(root, 'docker'), `#!/usr/bin/env bash\n${monitor}\n`, { mode: 0o755 })
    const log = join(root, 'arrivals.log')
    const result = spawnSync('bash', [script, 'fixture', log, 'bash', '-c', command], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root },
      encoding: 'utf8',
      timeout: 10_000,
    })
    return { ...result, log: readFileSync(log, 'utf8') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const readyMonitor = `
printf 'OK\\n'
while [[ ! -f "$FIXTURE_ROOT/send" ]]; do sleep 0.01; done
# Model a delayed write after the request; a fixed post-request sleep is not readiness.
sleep 0.2
printf '123.456 [0 127.0.0.1:1234] "DEL" "private-key" "private-value"\\n'
touch "$FIXTURE_ROOT/sent"
exec sleep 30
`

const requestCapturedWrite = `
touch "$FIXTURE_ROOT/send"
deadline=$((SECONDS + 5))
until [[ -f "$FIXTURE_ROOT/sent" ]]; do
  if (( SECONDS >= deadline )); then exit 1; fi
  sleep 0.01
done
`

test('captures commands throughout the test and removes arguments before writing', () => {
  const result = capture(readyMonitor, requestCapturedWrite)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.log, /123\.456 \[0 127\.0\.0\.1:1234\] "DEL"/)
  assert.ok(!result.log.includes('private'))
})

test('does not mistake MONITOR OK for captured test traffic', () => {
  const result = capture('printf "OK\\n"; exec sleep 30', 'true')
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.log.trim(), 'OK')
})

test('rejects a monitor that stops before the test finishes', () => {
  const result = capture('printf "OK\\n"; sleep 0.2', 'sleep 0.4')
  assert.notEqual(result.status, 0)
})

test('fails startup when the monitor exits before readiness', () => {
  const result = capture('exit 7', 'echo test-must-not-start')
  assert.notEqual(result.status, 0)
  assert.ok(!result.stdout.includes('test-must-not-start'))
})

test('bounds readiness independently of the test lifetime', () => {
  const result = capture('exec sleep 30', 'echo test-must-not-start')
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /did not become ready within 5 seconds/)
  assert.ok(!result.stdout.includes('test-must-not-start'))
})

test('preserves the test command failure without retries', () => {
  const result = capture(readyMonitor, `${requestCapturedWrite}\nexit 23`)
  assert.equal(result.status, 23, result.stderr)
  assert.match(result.log, /"DEL"/)
  assert.ok(!result.log.includes('private'))
})
