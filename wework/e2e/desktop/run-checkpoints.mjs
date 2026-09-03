import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DESKTOP_CHECKPOINTS } from './checkpoints.mjs'
import {
  compactInactiveDesktopE2EResults,
  resolveDesktopE2EResultRoot,
} from './result-retention.mjs'
import { prepareDesktopE2EBuild } from '../../scripts/lib/desktop-e2e-build.mjs'
import { runCommandToLog } from '../../scripts/lib/command-log.mjs'

const HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_PARALLEL_CHECKPOINTS = 1
const CHECKPOINT_SCENARIO_MODULES = {
  'cloud-space-mention': './scenarios/cloud-space-mention.scenario.mjs',
  'conversation-state': './scenarios/conversation-mention.scenario.mjs',
  'temporary-chat': './scenarios/temporary-chat.scenario.mjs',
  'embedded-browser': './scenarios/embedded-browser-agent.scenario.mjs',
  'change-request-status': './scenarios/change-request-status.scenario.mjs',
  'claude-runtime': './scenarios/claude-runtime.scenario.mjs',
  'local-file-preview': './scenarios/local-file-preview.scenario.mjs',
  'local-harness': './scenarios/local-terminal.scenario.mjs',
  'harness-apps': './scenarios/harness-apps.scenario.mjs',
  'browser-multi-tabs': './scenarios/embedded-browser-multi-tabs.scenario.mjs',
  'browser-toolbar-actions': './scenarios/embedded-browser-toolbar-actions.scenario.mjs',
  'browser-annotation-core': './scenarios/embedded-browser-annotation.scenario.mjs',
  'browser-annotation-anchors': './scenarios/embedded-browser-annotation.scenario.mjs',
  'browser-annotation-design': './scenarios/embedded-browser-annotation.scenario.mjs',
  'rendering-extensions': './scenarios/streaming-text.scenario.mjs',
  'runtime-task-queue': './scenarios/runtime-task-queue.scenario.mjs',
  'runtime-terminal-convergence': './scenarios/runtime-terminal-convergence.scenario.mjs',
  'executor-stream-recovery': './scenarios/executor-stream-recovery.scenario.mjs',
  'running-conversation-history': './scenarios/running-conversation-history.scenario.mjs',
  'codex-notification-isolation': './scenarios/codex-notification-isolation.scenario.mjs',
  'context-compaction': './scenarios/context-compaction.scenario.mjs',
  'computer-use': './scenarios/computer-use.scenario.mjs',
  'split-workbench': './scenarios/split-workbench.scenario.mjs',
  'release-package-startup': './scenarios/release-package-startup.scenario.mjs',
  'app-update-differential': './scenarios/app-update-differential.scenario.mjs',
  'component-update': './scenarios/component-update.scenario.mjs',
  'native-window-startup': './scenarios/native-window-startup.scenario.mjs',
  'native-window-chrome': './scenarios/native-window-chrome.scenario.mjs',
  'renderer-storage': './scenarios/renderer-storage.scenario.mjs',
  'tray-lifecycle': './scenarios/tray-lifecycle.scenario.mjs',
  'project-automation': './scenarios/project-automation.scenario.mjs',
  'project-assignment-notification': './scenarios/project-assignment-notification.scenario.mjs',
  'offline-local-project-space': './scenarios/offline-local-project-space.scenario.mjs',
  'cloud-context-resilience': './scenarios/cloud-context-resilience.scenario.mjs',
  'task-attachments': './scenarios/task-attachments.scenario.mjs',
  'external-content-import': './scenarios/external-content-import.scenario.mjs',
}
const SCENARIO_ONLY_CHECKPOINTS = new Set([
  'cloud-space-mention',
  'change-request-status',
  'claude-runtime',
  'local-file-preview',
  'local-harness',
  'harness-apps',
  'offline-local-project-space',
  'cloud-context-resilience',
  'task-attachments',
  'project-assignment-notification',
  'runtime-task-queue',
  'runtime-terminal-convergence',
  'executor-stream-recovery',
  'running-conversation-history',
  'codex-notification-isolation',
  'context-compaction',
  'computer-use',
  'split-workbench',
  'release-package-startup',
  'app-update-differential',
  'component-update',
  'native-window-startup',
  'native-window-chrome',
  'renderer-storage',
  'tray-lifecycle',
  'temporary-chat',
  'browser-annotation-core',
  'browser-annotation-anchors',
  'browser-annotation-design',
  'external-content-import',
])
const CLOUD_ONLY_CHECKPOINTS = new Set([
  'plugin-workspace-publication',
  'cloud-git-worktree',
  'cloud-worktree-capability',
  'cloud-worktree-create',
  'cloud-worktree-queued-cancel',
  'cloud-worktree-tools',
  'cloud-worktree-archive-restore',
  'cloud-worktree-device-restart',
])
const COMPOSITE_CHECKPOINTS = new Map([
  [
    'browser-annotation',
    ['browser-annotation-core', 'browser-annotation-anchors', 'browser-annotation-design'],
  ],
  [
    'cloud-git-worktree',
    [
      'cloud-worktree-capability',
      'cloud-worktree-create',
      'cloud-worktree-queued-cancel',
      'cloud-worktree-tools',
      'cloud-worktree-archive-restore',
      'cloud-worktree-device-restart',
    ],
  ],
])
const DEFAULT_DESKTOP_CHECKPOINTS = DESKTOP_CHECKPOINTS.filter(
  checkpoint => !COMPOSITE_CHECKPOINTS.has(checkpoint)
)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..', '..')
const taskFlowPath = join(scriptDir, 'task-flow.e2e.mjs')
const isolatedXvfbPath = join(scriptDir, 'run-with-openbox.sh')
const cliArgs = process.argv.slice(2)
const requestedArgs = cliArgs[0] === '--' ? cliArgs.slice(1) : cliArgs

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to reserve a desktop E2E port')
  }
  await new Promise(resolvePromise => server.close(resolvePromise))
  return address.port
}

function configuredPort(value, name) {
  if (value === undefined) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${name} must be a TCP port`)
  }
  return port
}

async function resolveServerPorts(env) {
  const configuredModelPort = configuredPort(
    env.WEWORK_E2E_MODEL_SERVER_PORT,
    'WEWORK_E2E_MODEL_SERVER_PORT'
  )
  const configuredControlPort = configuredPort(
    env.WEWORK_E2E_CONTROL_SERVER_PORT,
    'WEWORK_E2E_CONTROL_SERVER_PORT'
  )
  let modelServerPort = configuredModelPort ?? (await reservePort())
  let controlServerPort = configuredControlPort ?? (await reservePort())

  while (controlServerPort === modelServerPort) {
    if (configuredControlPort !== null && configuredModelPort !== null) {
      throw new Error('Desktop E2E control and model server ports must differ')
    }
    if (configuredControlPort !== null) {
      modelServerPort = await reservePort()
    } else {
      controlServerPort = await reservePort()
    }
  }
  return { controlServerPort, modelServerPort }
}

function runTaskFlow(args, env, label) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    let resultDir = null
    let outputTail = ''
    let stderrTail = ''
    const isolateDisplay = process.platform === 'linux' && env.WEWORK_E2E_ISOLATED_XVFB === 'true'
    const command = isolateDisplay ? 'xvfb-run' : process.execPath
    const commandArgs = isolateDisplay
      ? [
          '-a',
          '--server-args=-screen 0 1280x720x24',
          'sh',
          isolatedXvfbPath,
          process.execPath,
          taskFlowPath,
          ...args,
        ]
      : [taskFlowPath, ...args]
    const child = spawn(command, commandArgs, {
      env,
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
    child.once('exit', (code, signal) => {
      clearInterval(heartbeat)
      resolvePromise({
        code: code ?? 1,
        durationMs: Date.now() - startedAt,
        resultDir,
        signal,
        stderrTail,
      })
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
  if (checkpoint === 'native-window-chrome' || checkpoint === 'browser-multi-tabs') {
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

async function runDesktopBuild() {
  const startedAt = Date.now()
  const logPath = join(weworkDir, 'test-results', 'desktop-e2e', `desktop-build-${process.pid}.log`)
  console.log(
    `[desktop-e2e] Building the shared Electron application and executor. Full log: ${logPath}`
  )
  const heartbeat = setInterval(() => {
    console.log(
      `[desktop-e2e] Desktop build still running: elapsed=${formatDuration(Date.now() - startedAt)}`
    )
  }, HEARTBEAT_INTERVAL_MS)

  let result
  try {
    result = await runCommandToLog({
      args: ['run', 'ai:verify:electron:build'],
      command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      cwd: weworkDir,
      env: process.env,
      logPath,
    })
  } finally {
    clearInterval(heartbeat)
  }

  if (result.code !== 0) {
    console.error(
      `[desktop-e2e] Desktop build failed: ${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}. Full log: ${logPath}`
    )
    if (result.tail.trim()) {
      console.error(`[desktop-e2e] Desktop build output tail:\n${result.tail.trimEnd()}`)
    }
    throw new Error(`Desktop E2E build exited with code ${result.code}`)
  }
  console.log(
    `[desktop-e2e] Desktop build passed: duration=${formatDuration(Date.now() - startedAt)}. Full log: ${logPath}`
  )
}

async function sharedBuildEnvironment(environment = process.env) {
  const build = await prepareDesktopE2EBuild({
    environment,
    runBuild: runDesktopBuild,
    weworkDir,
  })
  console.log(
    `[desktop-e2e] shared build ready: app=${build.appBinary}, executor=${build.executorBinary}`
  )
  return {
    ...environment,
    WEWORK_E2E_APP_BIN: build.appBinary,
    WEWORK_E2E_EXECUTOR_BIN: build.executorBinary,
  }
}

function requestedCheckpointRange(args) {
  if (args.length !== 2) return null
  const [flag, checkpoint] = args
  if (flag === '--segment') return expandCompositeCheckpoints([checkpoint])
  if (flag === '--from-segment') {
    const startCheckpoint = COMPOSITE_CHECKPOINTS.get(checkpoint)?.[0] ?? checkpoint
    const startIndex = DEFAULT_DESKTOP_CHECKPOINTS.indexOf(startCheckpoint)
    if (startIndex < 0) return null
    return DEFAULT_DESKTOP_CHECKPOINTS.slice(startIndex)
  }
  return null
}

function expandCompositeCheckpoints(checkpoints) {
  const expanded = []
  const seen = new Set()
  for (const checkpoint of checkpoints) {
    const members = COMPOSITE_CHECKPOINTS.get(checkpoint) ?? [checkpoint]
    for (const member of members) {
      if (seen.has(member)) continue
      seen.add(member)
      expanded.push(member)
    }
  }
  return expanded
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
  for (const checkpoint of checkpoints) {
    if (!DESKTOP_CHECKPOINTS.includes(checkpoint)) {
      throw new Error(`Unknown desktop E2E checkpoint: ${checkpoint}`)
    }
  }
  return expandCompositeCheckpoints(checkpoints)
}

function parallelCheckpointLimit() {
  const value = Number(process.env.WEWORK_E2E_PARALLEL_CHECKPOINTS ?? DEFAULT_PARALLEL_CHECKPOINTS)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('WEWORK_E2E_PARALLEL_CHECKPOINTS must be a positive integer')
  }
  return value
}

function parallelCheckpointArgs(checkpoint) {
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
  const env = await sharedBuildEnvironment()
  console.log(`[desktop-e2e] START ${label}`)
  const result = await runTaskFlow(requestedArgs, env, label)
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
  const sharedEnv = await sharedBuildEnvironment()
  const pending = [...checkpoints]
  const failures = []
  const workerCount = Math.min(parallelCheckpointLimit(), pending.length)
  console.log(
    `[desktop-e2e] Running ${pending.length} checkpoints with ${workerCount} parallel workers`
  )

  async function runWorker() {
    while (pending.length > 0) {
      const checkpoint = pending.shift()
      if (!checkpoint) return
      const env = checkpointScenarioEnv({ ...sharedEnv }, checkpoint)
      delete env.WEWORK_E2E_CONTROL_SERVER_PORT
      delete env.WEWORK_E2E_MODEL_SERVER_PORT
      console.log(`\n[desktop-e2e] START ${checkpoint}`)
      const result = await runTaskFlow(parallelCheckpointArgs(checkpoint), env, checkpoint)
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
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
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
}

async function runCheckpoints(checkpoints) {
  const sharedEnv = await sharedBuildEnvironment()
  const { controlServerPort, modelServerPort } = await resolveServerPorts(sharedEnv)
  const failures = []

  for (const checkpoint of checkpoints) {
    const env = checkpointScenarioEnv(
      {
        ...sharedEnv,
        WEWORK_E2E_CONTROL_SERVER_PORT: String(controlServerPort),
        WEWORK_E2E_MODEL_SERVER_PORT: String(modelServerPort),
      },
      checkpoint
    )
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
