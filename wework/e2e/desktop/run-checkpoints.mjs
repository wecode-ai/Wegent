import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DESKTOP_CHECKPOINTS } from './checkpoints.mjs'

const HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_PARALLEL_CHECKPOINTS = 3
const CHECKPOINT_SCENARIO_MODULES = {
  'conversation-state': './scenarios/conversation-mention.scenario.mjs',
  'embedded-browser': './scenarios/embedded-browser-agent.scenario.mjs',
  'local-harness': './scenarios/local-terminal.scenario.mjs',
  'browser-multi-tabs': './scenarios/embedded-browser-multi-tabs.scenario.mjs',
  'rendering-extensions': './scenarios/streaming-text.scenario.mjs',
  'runtime-task-queue': './scenarios/runtime-task-queue.scenario.mjs',
  'project-automation': './scenarios/project-automation.scenario.mjs',
}
const SCENARIO_ONLY_CHECKPOINTS = new Set(['local-harness', 'runtime-task-queue'])
const scriptDir = dirname(fileURLToPath(import.meta.url))
const taskFlowPath = join(scriptDir, 'task-flow.e2e.mjs')
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
      ? ['-a', '--server-args=-screen 0 1280x720x24', process.execPath, taskFlowPath, ...args]
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

async function readBuildManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function checkpointScenarioEnv(env, checkpoint) {
  const nextEnv = { ...env }
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

function existingBuildManifest(env) {
  if (!env.WEWORK_E2E_APP_BIN || !env.WEWORK_E2E_EXECUTOR_BIN) return null
  return {
    appBinary: env.WEWORK_E2E_APP_BIN,
    executorBinary: env.WEWORK_E2E_EXECUTOR_BIN,
  }
}

function requestedCheckpointRange(args) {
  if (args.length !== 2) return null
  const [flag, checkpoint] = args
  const startIndex = DESKTOP_CHECKPOINTS.indexOf(checkpoint)
  if (startIndex < 0) return null
  if (flag === '--segment') return [checkpoint]
  if (flag === '--from-segment') return DESKTOP_CHECKPOINTS.slice(startIndex)
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
  for (const checkpoint of checkpoints) {
    if (!DESKTOP_CHECKPOINTS.includes(checkpoint)) {
      throw new Error(`Unknown desktop E2E checkpoint: ${checkpoint}`)
    }
  }
  return checkpoints
}

function parallelCheckpointLimit() {
  const value = Number(process.env.WEWORK_E2E_PARALLEL_CHECKPOINTS ?? DEFAULT_PARALLEL_CHECKPOINTS)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('WEWORK_E2E_PARALLEL_CHECKPOINTS must be a positive integer')
  }
  return value
}

async function runRequestedArgs() {
  const parallelCheckpoints = requestedParallelCheckpoints(requestedArgs)
  if (parallelCheckpoints) return runParallelCheckpoints(parallelCheckpoints)

  const checkpoints = requestedCheckpointRange(requestedArgs)
  if (checkpoints) return runCheckpoints(checkpoints)

  const label = requestedArgs.join(' ') || 'desktop task flow'
  console.log(`[desktop-e2e] START ${label}`)
  const result = await runTaskFlow(requestedArgs, process.env, label)
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
  if (!existingBuildManifest(process.env)) {
    throw new Error('--parallel-segments requires a prebuilt desktop E2E application and executor')
  }

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
      const env = checkpointScenarioEnv({ ...process.env }, checkpoint)
      delete env.WEWORK_E2E_CONTROL_SERVER_PORT
      delete env.WEWORK_E2E_MODEL_SERVER_PORT
      console.log(`\n[desktop-e2e] START ${checkpoint}`)
      const result = await runTaskFlow(['--cloud-only', '--segment', checkpoint], env, checkpoint)
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
  const tempDir = await mkdtemp(join(tmpdir(), 'wework-desktop-e2e-'))
  const buildManifestPath = join(tempDir, 'build-manifest.json')
  const { controlServerPort, modelServerPort } = await resolveServerPorts(process.env)
  const failures = []
  let buildManifest = existingBuildManifest(process.env)

  try {
    for (const checkpoint of checkpoints) {
      const env = checkpointScenarioEnv(
        {
          ...process.env,
          WEWORK_E2E_CONTROL_SERVER_PORT: String(controlServerPort),
          WEWORK_E2E_MODEL_SERVER_PORT: String(modelServerPort),
          ...(buildManifest
            ? {
                WEWORK_E2E_APP_BIN: buildManifest.appBinary,
                WEWORK_E2E_EXECUTOR_BIN: buildManifest.executorBinary,
              }
            : {
                WEWORK_E2E_BUILD_MANIFEST: buildManifestPath,
              }),
        },
        checkpoint
      )
      console.log(`\n[desktop-e2e] START ${checkpoint}`)
      const result = await runTaskFlow(['--segment', checkpoint], env, checkpoint)

      if (!buildManifest && !existingBuildManifest(env)) {
        try {
          buildManifest = await readBuildManifest(buildManifestPath)
          console.log(
            `[desktop-e2e] shared build ready: app=${buildManifest.appBinary}, executor=${buildManifest.executorBinary}`
          )
        } catch (error) {
          const failure = `Shared E2E build was unavailable: ${error instanceof Error ? error.message : String(error)}`
          failures.push({ checkpoint, failure, ...result })
          console.error(
            `[desktop-e2e] FAIL ${checkpoint}: duration=${formatDuration(result.durationMs)}, error=${failure}${result.resultDir ? `, evidence=${result.resultDir}` : ''}`
          )
          break
        }
      }

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
  } finally {
    await rm(tempDir, { force: true, recursive: true })
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
  await runCheckpoints(DESKTOP_CHECKPOINTS)
}

if (requestedArgs.length > 0) {
  await runRequestedArgs()
} else {
  await runAllCheckpoints()
}
