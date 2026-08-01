import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DESKTOP_CHECKPOINTS } from './checkpoints.mjs'

const HEARTBEAT_INTERVAL_MS = 30_000
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

function runTaskFlow(args, env, label) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    let resultDir = null
    let outputTail = ''
    let stderrTail = ''
    const child = spawn(process.execPath, [taskFlowPath, ...args], {
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

async function runRequestedArgs() {
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

async function runAllCheckpoints() {
  const tempDir = await mkdtemp(join(tmpdir(), 'wework-desktop-e2e-'))
  const buildManifestPath = join(tempDir, 'build-manifest.json')
  const modelServerPort = await reservePort()
  let controlServerPort = await reservePort()
  while (controlServerPort === modelServerPort) {
    controlServerPort = await reservePort()
  }
  const failures = []
  let buildManifest = null

  try {
    for (const checkpoint of DESKTOP_CHECKPOINTS) {
      const env = {
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
      }
      console.log(`\n[desktop-e2e] START ${checkpoint}`)
      const result = await runTaskFlow(['--segment', checkpoint], env, checkpoint)

      if (!buildManifest) {
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

if (requestedArgs.length > 0) {
  await runRequestedArgs()
} else {
  await runAllCheckpoints()
}
