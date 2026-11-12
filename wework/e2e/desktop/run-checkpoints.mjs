import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHECKPOINT_RESOURCES,
  CHECKPOINT_SCENARIO_MODULES,
  SCENARIO_ONLY_CHECKPOINTS,
  CLOUD_ONLY_CHECKPOINTS,
  DESKTOP_CHECKPOINTS,
  DESKTOP_CHECKPOINT_GROUPS,
  expandDesktopCheckpoints,
} from './checkpoints.mjs'
import {
  isResourceExclusiveCheckpoint,
  linuxCoreCheckpointResources,
  runWithCheckpointResources,
} from './checkpoint-scheduler.mjs'
import { UPGRADE_DIAGNOSTIC_CHECKPOINTS, rejectFailedReleaseCheckpoint } from './upgrade-suite.mjs'
import { rejectRecordedCheckpointFailure } from './checkpoint-result.mjs'
import { createXvfbDisplayAllocator, prepareXvfbSocketDirectory } from './xvfb-display.mjs'
import { resolveDesktopCodexBinary } from './modules/desktop-build-flows.mjs'
import {
  compactInactiveDesktopE2EResults,
  resolveDesktopE2EResultRoot,
} from './result-retention.mjs'
import { prepareDesktopE2EBuild } from '../../scripts/lib/desktop-e2e-build.mjs'
import { runCommandToLog } from '../../scripts/lib/command-log.mjs'
import { prepareBundledRuntimeCache } from './modules/bundled-runtime-cache.mjs'

const HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_PARALLEL_CHECKPOINTS = 1
const COMPOSITE_CHECKPOINTS = DESKTOP_CHECKPOINT_GROUPS
const DEFAULT_DESKTOP_CHECKPOINTS = DESKTOP_CHECKPOINTS.filter(
  checkpoint => !COMPOSITE_CHECKPOINTS.has(checkpoint)
)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..', '..')
const taskFlowPath = join(scriptDir, 'task-flow.e2e.mjs')
const isolatedXvfbPath = join(scriptDir, 'run-with-xvfb.sh')
const openboxPath = join(scriptDir, 'run-with-openbox.sh')
const keyringPath = join(scriptDir, 'run-with-keyring.sh')
const cliArgs = process.argv.slice(2)
const requestedArgs = cliArgs[0] === '--' ? cliArgs.slice(1) : cliArgs
const allocateXvfbDisplay = createXvfbDisplayAllocator()

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Run one checkpoint with an isolated display and retain fully drained failure evidence. */
function runTaskFlow(args, env, label) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    let resultDir = null
    let outputTail = ''
    let stderrTail = ''
    const isolateDisplay = process.platform === 'linux' && env.WEWORK_E2E_ISOLATED_XVFB === 'true'
    const command = isolateDisplay ? 'sh' : process.execPath
    const commandArgs = isolateDisplay
      ? [
          isolatedXvfbPath,
          'dbus-run-session',
          '--',
          'sh',
          keyringPath,
          'sh',
          openboxPath,
          process.execPath,
          taskFlowPath,
          ...args,
        ]
      : [taskFlowPath, ...args]
    const child = spawn(command, commandArgs, {
      env: isolateDisplay
        ? { ...env, WEWORK_E2E_XVFB_SERVER_NUM: String(allocateXvfbDisplay()) }
        : env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const forward = (chunk, destination, captureStderr = false) => {
      lastOutputAt = Date.now()
      const text = chunk.toString()
      destination.write(text)
      outputTail = `${outputTail}${text}`.slice(-12_000)
      const resultDirMatch = outputTail.match(/\[desktop-e2e] result directory: ([^\r\n]+)/)
      if (resultDirMatch) resultDir = resultDirMatch[1].trim()
      if (captureStderr) stderrTail = `${stderrTail}${text}`.slice(-12_000)
    }
    child.stdout.on('data', chunk => forward(chunk, process.stdout))
    child.stderr.on('data', chunk => forward(chunk, process.stderr, true))

    const heartbeat = setInterval(() => {
      const now = Date.now()
      console.log(
        `[desktop-e2e] ${label} still running: elapsed=${formatDuration(now - startedAt)}, last-output=${formatDuration(now - lastOutputAt)} ago`
      )
    }, HEARTBEAT_INTERVAL_MS)

    child.once('error', error => {
      clearInterval(heartbeat)
      reject(error)
    })
    // Drain startup stderr before capturing failure details; exit can precede it.
    child.once('close', (code, signal) => {
      clearInterval(heartbeat)
      rejectRecordedCheckpointFailure({
        code: code ?? 1,
        durationMs: Date.now() - startedAt,
        resultDir,
        signal,
        stderrTail,
      }).then(resolvePromise, reject)
    })
  })
}

async function readFailureSummary(result) {
  if (result.resultDir) {
    try {
      const failure = await readFile(join(result.resultDir, 'failure.txt'), 'utf8')
      const firstLine = failure.split(/\r?\n/, 1)[0]?.trim()
      if (firstLine) return firstLine
    } catch {
      // Fall back to captured stderr when failure evidence was not written.
    }
  }
  return (
    result.stderrTail
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .at(-1) ?? 'No failure details were emitted'
  )
}

function checkpointScenarioEnv(env, checkpoint) {
  const nextEnv = { ...env }
  if (checkpoint === 'workspace-attachments') {
    nextEnv.WEWORK_E2E_HOST_PIPE_DIAGNOSTICS = '1'
  }
  if (
    [
      'human-interactions',
      'human-interactions-hidden',
      'human-interactions-issue',
      'stand-in-notifications',
    ].includes(checkpoint)
  ) {
    // Narrow 760px-tall content viewports must fit inside the physical display.
    nextEnv.WEWORK_E2E_XVFB_SCREEN = '1280x900x24'
  }
  if (UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(checkpoint)) {
    nextEnv.WEWORK_E2E_APP_BIN = env.WEWORK_E2E_UPGRADE_SOURCE_APP_BIN || env.WEWORK_E2E_APP_BIN
    nextEnv.WEWORK_E2E_EXECUTOR_BIN =
      env.WEWORK_E2E_UPGRADE_SOURCE_EXECUTOR_BIN || env.WEWORK_E2E_EXECUTOR_BIN
    nextEnv.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE = '1'
  }
  if (checkpoint === 'collaboration-shared-core') {
    // Exercise timezone-less UTC API timestamps outside the UTC timezone.
    nextEnv.TZ = 'Asia/Shanghai'
  }
  if (
    checkpoint === 'application-menu' ||
    checkpoint === 'native-window-chrome' ||
    checkpoint === 'window-lifecycle' ||
    checkpoint === 'window-background-policy' ||
    checkpoint === 'browser-multi-tabs' ||
    checkpoint === 'core-task-flow' ||
    checkpoint === 'project-assignment-notification' ||
    checkpoint === 'stand-in-profile-settings' ||
    checkpoint === 'stand-in-git' ||
    checkpoint.startsWith('human-interactions')
  ) {
    // Native windows and keyboard input need foreground activation.
    // macOS background mode prohibits activation and hides the app.
    // Assignment notification also verifies tag commits through native focus loss.
    nextEnv.WEWORK_E2E_BACKGROUND_WINDOW = '0'
  }
  const module = CHECKPOINT_SCENARIO_MODULES[checkpoint]
  if (module) {
    nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_MODULE = module
  } else {
    delete nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_MODULE
  }
  if (SCENARIO_ONLY_CHECKPOINTS.has(checkpoint)) {
    nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_ONLY = 'true'
  } else {
    delete nextEnv.WEWORK_E2E_DESKTOP_SCENARIO_ONLY
  }
  return nextEnv
}

async function runDesktopBuild({
  command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  args = ['run', 'ai:verify:electron:build'],
  environment = process.env,
  label = 'Desktop build',
  logPath = join(weworkDir, 'test-results', 'desktop-e2e', `desktop-build-${process.pid}.log`),
} = {}) {
  const startedAt = Date.now()
  console.log(`[desktop-e2e] ${label} started. Full log: ${logPath}`)
  const heartbeat = setInterval(() => {
    console.log(
      `[desktop-e2e] ${label} still running: elapsed=${formatDuration(Date.now() - startedAt)}`
    )
  }, HEARTBEAT_INTERVAL_MS)

  let result
  try {
    result = await runCommandToLog({
      args,
      command,
      cwd: weworkDir,
      env: environment,
      logPath,
    })
  } finally {
    clearInterval(heartbeat)
  }

  if (result.code !== 0) {
    console.error(
      `[desktop-e2e] ${label} failed: ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}. Full log: ${logPath}`
    )
    if (result.tail.trim()) {
      console.error(`[desktop-e2e] ${label} output tail:\n${result.tail.trimEnd()}`)
    }
    throw new Error(`${label} exited with code ${result.code}`)
  }
  console.log(
    `[desktop-e2e] ${label} passed: duration=${formatDuration(Date.now() - startedAt)}. Full log: ${logPath}`
  )
}

function requirePrebuiltUpgradePair(checkpoints, environment) {
  if (
    checkpoints.some(value => UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(value)) &&
    !environment.WEWORK_E2E_UPGRADE_PAIR
  )
    throw new Error(
      'Upgrade checkpoints require a prebuilt source/target pair; this test task never builds packages'
    )
}

async function sharedBuildEnvironment(environment = process.env, selectedCheckpoints) {
  if (process.platform === 'linux' && environment.WEWORK_E2E_ISOLATED_XVFB === 'true') {
    await prepareXvfbSocketDirectory()
  }
  let nextEnvironment = environment
  const selected =
    selectedCheckpoints ??
    requestedParallelCheckpoints(requestedArgs) ??
    requestedCheckpointRange(requestedArgs) ??
    []
  const upgradeRequested = selected.some(value => UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(value))
  requirePrebuiltUpgradePair(selected, environment)
  if (upgradeRequested) {
    const pairPath = resolve(environment.WEWORK_E2E_UPGRADE_PAIR)
    const pair = JSON.parse(await readFile(pairPath, 'utf8'))
    nextEnvironment = {
      ...environment,
      ...(selected.every(value => UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(value))
        ? {
            WEWORK_E2E_APP_BIN: pair.from.executable,
            WEWORK_E2E_EXECUTOR_BIN: pair.from.executor,
            WEWORK_E2E_CODEX_BIN: pair.from.codex,
          }
        : {}),
      WEWORK_E2E_UPGRADE_SOURCE_APP_BIN: pair.from.executable,
      WEWORK_E2E_UPGRADE_SOURCE_EXECUTOR_BIN: pair.from.executor,
      WEWORK_E2E_UPGRADE_PAIR: pairPath,
    }
  }
  const [build, codexBinary] = await Promise.all([
    prepareDesktopE2EBuild({
      environment: nextEnvironment,
      runBuild: upgradeRequested
        ? () => {
            throw new Error('Upgrade checkpoints require prebuilt desktop binaries')
          }
        : runDesktopBuild,
      weworkDir,
    }),
    resolveDesktopCodexBinary(nextEnvironment),
  ])
  console.log(
    `[desktop-e2e] shared build ready: app=${build.appBinary}, executor=${build.executorBinary}, codex=${codexBinary}`
  )
  return {
    ...nextEnvironment,
    WEWORK_E2E_APP_BIN: build.appBinary,
    WEWORK_E2E_CODEX_BIN: codexBinary,
    WEWORK_E2E_EXECUTOR_BIN: build.executorBinary,
  }
}

async function prepareSharedHarnessRuntime(appBinary, parentDirectory) {
  const resources = resolve(
    dirname(appBinary),
    ...(process.platform === 'darwin' ? ['..', 'Resources'] : ['resources'])
  )
  return prepareBundledRuntimeCache(resources, join(parentDirectory, 'harness-runtime'))
}

function requestedCheckpointRange(args) {
  if (args.length !== 2) return null
  const [flag, checkpoint] = args
  if (flag === '--segment') return expandDesktopCheckpoints([checkpoint])
  if (flag === '--from-segment') {
    const startCheckpoint = COMPOSITE_CHECKPOINTS.get(checkpoint)?.[0] ?? checkpoint
    const startIndex = DEFAULT_DESKTOP_CHECKPOINTS.indexOf(startCheckpoint)
    if (startIndex < 0) return null
    return DEFAULT_DESKTOP_CHECKPOINTS.slice(startIndex)
  }
  return null
}

function requestedParallelCheckpoints(args) {
  if (args.length !== 2 || args[0] !== '--parallel-segments') return null
  const checkpoints = args[1]
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  if (checkpoints.length === 0) {
    throw new Error('--parallel-segments requires at least one checkpoint')
  }
  const expanded = expandDesktopCheckpoints(checkpoints)
  for (const checkpoint of expanded) {
    if (!DESKTOP_CHECKPOINTS.includes(checkpoint)) {
      throw new Error(`Unknown desktop E2E checkpoint: ${checkpoint}`)
    }
  }
  return expanded
}

function parallelCheckpointLimit() {
  const value = Number(process.env.WEWORK_E2E_PARALLEL_CHECKPOINTS ?? DEFAULT_PARALLEL_CHECKPOINTS)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('WEWORK_E2E_PARALLEL_CHECKPOINTS must be a positive integer')
  }
  return value
}

function parallelCheckpointArgs(checkpoint) {
  // Scenario modules declare their own cloud prerequisites. Cloud is a shard
  // scope here, not a second mutually exclusive task-flow execution mode.
  if (SCENARIO_ONLY_CHECKPOINTS.has(checkpoint)) return ['--segment', checkpoint]
  const scope = process.env.WEWORK_E2E_PARALLEL_SCOPE ?? 'cloud'
  if (scope === 'cloud') return ['--cloud-only', '--segment', checkpoint]
  if (scope === 'core') return ['--segment', checkpoint]
  throw new Error('WEWORK_E2E_PARALLEL_SCOPE must be "cloud" or "core"')
}

async function runRequestedArgs() {
  const parallelCheckpoints = requestedParallelCheckpoints(requestedArgs)
  if (parallelCheckpoints) return runParallelCheckpoints(parallelCheckpoints)

  const checkpoints = requestedCheckpointRange(requestedArgs)
  if (checkpoints) return runCheckpoints(checkpoints)

  const label = requestedArgs.join(' ') || 'desktop task flow'
  const sharedEnv = await sharedBuildEnvironment()
  const segmentIndex = requestedArgs.indexOf('--segment')
  const checkpoint = segmentIndex >= 0 ? requestedArgs[segmentIndex + 1] : undefined
  const env = segmentIndex >= 0 ? checkpointScenarioEnv(sharedEnv, checkpoint) : sharedEnv
  const args = SCENARIO_ONLY_CHECKPOINTS.has(checkpoint)
    ? requestedArgs.filter(argument => argument !== '--cloud-only')
    : requestedArgs
  console.log(`[desktop-e2e] START ${label}`)
  const result = await runTaskFlow(args, env, label)
  if (result.code === 0) {
    console.log(
      `[desktop-e2e] PASS ${label}: duration=${formatDuration(result.durationMs)}, assertion-errors=none${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
    )
    return
  }
  const failure = await readFailureSummary(result)
  console.error(
    `[desktop-e2e] FAIL ${label}: duration=${formatDuration(result.durationMs)}, ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}, error=${failure}${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
  )
  process.exitCode = result.code
}

async function runParallelCheckpoints(checkpoints) {
  const sharedRuntimeDirectory = await mkdtemp(join(tmpdir(), 'wework-e2e-shared-'))
  try {
    const baseEnvironment = await sharedBuildEnvironment(process.env, checkpoints)
    const sharedHarnessRuntime = checkpoints.every(checkpoint =>
      UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(checkpoint)
    )
      ? null
      : baseEnvironment.WEWORK_E2E_HARNESS_RUNTIME_ROOT?.trim() ||
        (await prepareSharedHarnessRuntime(
          baseEnvironment.WEWORK_E2E_APP_BIN,
          sharedRuntimeDirectory
        ))
    const sharedEnv = {
      ...baseEnvironment,
      ...(sharedHarnessRuntime ? { WEWORK_E2E_HARNESS_RUNTIME_ROOT: sharedHarnessRuntime } : {}),
      WEWORK_E2E_PORT_REGISTRY_DIR: sharedRuntimeDirectory,
    }
    const failures = []
    const activeCheckpoints = new Set()
    const workerCount = Math.min(parallelCheckpointLimit(), checkpoints.length)
    const logActivity = (event, checkpoint) => {
      console.log(
        `[desktop-e2e-schedule] ${JSON.stringify({
          timestamp: new Date().toISOString(),
          event,
          checkpoint,
          workerCount,
          activeCount: activeCheckpoints.size,
          activeCheckpoints: [...activeCheckpoints],
        })}`
      )
    }
    console.log(
      `[desktop-e2e] Running ${checkpoints.length} checkpoints with ${workerCount} parallel workers`
    )

    const linuxCore =
      process.platform === 'linux' && process.env.WEWORK_E2E_PARALLEL_SCOPE === 'core'
    await runWithCheckpointResources({
      checkpoints,
      workerCount,
      resourceFor: checkpoint => {
        if (linuxCore) return linuxCoreCheckpointResources(checkpoint)
        return process.platform === 'darwin' ? CHECKPOINT_RESOURCES.get(checkpoint) : []
      },
      exclusiveFor: checkpoint => isResourceExclusiveCheckpoint(checkpoint, linuxCore),
      run: async checkpoint => {
        const env = checkpointScenarioEnv({ ...sharedEnv }, checkpoint)
        delete env.WEWORK_E2E_CONTROL_SERVER_PORT
        delete env.WEWORK_E2E_MODEL_SERVER_PORT
        console.log(`\n[desktop-e2e] START ${checkpoint}`)
        activeCheckpoints.add(checkpoint)
        logActivity('start', checkpoint)
        let result
        try {
          result = await runTaskFlow(parallelCheckpointArgs(checkpoint), env, checkpoint)
        } finally {
          activeCheckpoints.delete(checkpoint)
          logActivity('end', checkpoint)
        }
        if (result.code === 0) {
          console.log(
            `[desktop-e2e] PASS ${checkpoint}: duration=${formatDuration(result.durationMs)}, assertion-errors=none${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
          )
          return
        }
        const failure = await readFailureSummary(result)
        failures.push({ checkpoint, failure, ...result })
        console.error(
          `[desktop-e2e] FAIL ${checkpoint}: duration=${formatDuration(result.durationMs)}, ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}, error=${failure}${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
        )
        // A failed pair cannot authorize an edge; retain diagnostics and try the next source.
        if (workerCount === 1) rejectFailedReleaseCheckpoint(checkpoint, result)
      },
    })
    if (failures.length === 0) {
      console.log('\n[desktop-e2e] All parallel checkpoints passed.')
      return
    }

    console.error('\n[desktop-e2e] Parallel checkpoint failure summary:')
    for (const failure of failures) {
      console.error(
        `- ${failure.checkpoint}: ${failure.failure}${failure.resultDir ? ` (${failure.resultDir})` : ''}`
      )
    }
    process.exitCode = 1
  } finally {
    await rm(sharedRuntimeDirectory, { recursive: true, force: true })
  }
}

async function runCheckpoints(checkpoints) {
  const sharedEnv = await sharedBuildEnvironment(process.env, checkpoints)
  const failures = []

  for (const checkpoint of checkpoints) {
    const env = checkpointScenarioEnv({ ...sharedEnv }, checkpoint)
    console.log(`\n[desktop-e2e] START ${checkpoint}`)
    const args = CLOUD_ONLY_CHECKPOINTS.has(checkpoint)
      ? ['--cloud-only', '--segment', checkpoint]
      : ['--segment', checkpoint]
    const result = await runTaskFlow(args, env, checkpoint)

    if (result.code === 0) {
      console.log(
        `[desktop-e2e] PASS ${checkpoint}: duration=${formatDuration(result.durationMs)}, assertion-errors=none${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
      )
      continue
    }

    const failure = await readFailureSummary(result)
    failures.push({ checkpoint, failure, ...result })
    console.error(
      `[desktop-e2e] FAIL ${checkpoint}: duration=${formatDuration(result.durationMs)}, ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}, error=${failure}${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
    )
  }

  if (failures.length === 0) {
    console.log('\n[desktop-e2e] All checkpoints passed.')
    return
  }

  console.error('\n[desktop-e2e] Checkpoint failure summary:')
  for (const failure of failures) {
    console.error(
      `- ${failure.checkpoint}: ${failure.failure}${failure.resultDir ? ` (${failure.resultDir})` : ''}`
    )
  }
  process.exitCode = 1
}

async function runAllCheckpoints() {
  await runCheckpoints(DEFAULT_DESKTOP_CHECKPOINTS)
}

requirePrebuiltUpgradePair(
  requestedParallelCheckpoints(requestedArgs) ?? requestedCheckpointRange(requestedArgs) ?? [],
  process.env
)
const previousResults = await compactInactiveDesktopE2EResults(
  resolveDesktopE2EResultRoot(weworkDir)
)
if (previousResults.compacted > 0) {
  console.log(`[desktop-e2e] compacted ${previousResults.compacted} previous result directories`)
}

if (requestedArgs.length > 0) {
  await runRequestedArgs()
} else {
  await runAllCheckpoints()
}
