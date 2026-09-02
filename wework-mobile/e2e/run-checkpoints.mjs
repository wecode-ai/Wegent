import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { MOBILE_CHECKPOINTS } from './checkpoints.mjs'

const mobileDir = resolve(import.meta.dirname, '..')
const workerPath = resolve(import.meta.dirname, 'run.mjs')
const platform = process.argv[2]
const requestedFlow = readOption('--flow')
const requestedCheckpoints = readOption('--checkpoints')
const reuseApp = process.argv.includes('--reuse-app')
const supportedPlatforms = new Set(['ios', 'android'])
const heartbeatIntervalMs = 30_000
const maestroDriverStartupTimeoutMs = 3 * 60_000

assert.ok(
  supportedPlatforms.has(platform),
  'Usage: node e2e/run-checkpoints.mjs <ios|android> [--flow name | --checkpoints a,b] [--reuse-app]'
)
assert.ok(
  !(requestedFlow && requestedCheckpoints),
  '--flow and --checkpoints cannot be used together'
)

const checkpoints = resolveCheckpoints()
const failures = []

for (const [index, checkpoint] of checkpoints.entries()) {
  const shouldReuseApp = reuseApp || index > 0
  const result = await runCheckpoint(checkpoint, shouldReuseApp)
  if (result.code === 0) {
    console.log(
      `[mobile-e2e] PASS ${platform}/${checkpoint}: duration=${formatDuration(result.durationMs)}`
    )
    continue
  }
  failures.push({ checkpoint, ...result })
  console.error(
    `[mobile-e2e] FAIL ${platform}/${checkpoint}: duration=${formatDuration(result.durationMs)}, ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}`
  )
}

if (failures.length === 0) {
  console.log(`[mobile-e2e] All ${platform} checkpoints passed.`)
} else {
  console.error(`[mobile-e2e] ${platform} checkpoint failure summary:`)
  for (const failure of failures) {
    console.error(
      `- ${failure.checkpoint}: ${failure.signal ? `signal=${failure.signal}` : `exit=${failure.code}`}`
    )
  }
  process.exitCode = 1
}

function resolveCheckpoints() {
  const values = requestedFlow
    ? [requestedFlow]
    : requestedCheckpoints
      ? requestedCheckpoints
          .split(',')
          .map(value => value.trim())
          .filter(Boolean)
      : MOBILE_CHECKPOINTS
  assert.ok(values.length > 0, '--checkpoints requires at least one checkpoint')
  for (const checkpoint of values) {
    assert.ok(
      MOBILE_CHECKPOINTS.includes(checkpoint),
      `Unknown Mobile E2E checkpoint: ${checkpoint}`
    )
  }
  assert.equal(new Set(values).size, values.length, 'Mobile E2E checkpoints must not be duplicated')
  return values
}

async function runCheckpoint(checkpoint, shouldReuseApp) {
  const startedAt = Date.now()
  const args = [workerPath, platform, '--flow', checkpoint]
  if (shouldReuseApp) args.push('--reuse-app')
  console.log(`[mobile-e2e] START ${platform}/${checkpoint}`)
  const heartbeat = setInterval(() => {
    console.log(
      `[mobile-e2e] ${platform}/${checkpoint} still running: elapsed=${formatDuration(Date.now() - startedAt)}`
    )
  }, heartbeatIntervalMs)

  try {
    const worker = await runChild(process.execPath, args)
    if (worker.code !== 0 || checkpoint !== 'composer') {
      return { ...worker, durationMs: Date.now() - startedAt }
    }

    console.log(`[mobile-e2e] START ${platform}/composer attachment cleanup`)
    const cleanup = await runComposerAttachmentCleanup()
    return { ...cleanup, durationMs: Date.now() - startedAt }
  } finally {
    clearInterval(heartbeat)
  }
}

function runComposerAttachmentCleanup() {
  const maestro = process.env.MAESTRO_BIN?.trim() || 'maestro'
  const device = process.env.WEWORK_MOBILE_E2E_DEVICE?.trim()
  const args = [
    ...(device ? ['--device', device] : []),
    'test',
    '--format',
    'junit',
    '--output',
    join(
      mobileDir,
      'test-results',
      'mobile-e2e',
      `maestro-${platform}-composer-attachment-cleanup-${Date.now()}.xml`
    ),
    join(mobileDir, '.maestro', 'composer-attachment-cleanup.yaml'),
  ]
  return runChild(maestro, args, {
    ...process.env,
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    MAESTRO_CLI_NO_ANALYTICS: 'true',
    MAESTRO_DISABLE_UPDATE_CHECK: 'true',
    MAESTRO_DRIVER_STARTUP_TIMEOUT: String(maestroDriverStartupTimeoutMs),
  })
}

function runChild(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: mobileDir, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolvePromise({ code: code ?? 1, signal })
    })
  })
}

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  assert.ok(value && !value.startsWith('--'), `${name} requires a value`)
  return value
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}
