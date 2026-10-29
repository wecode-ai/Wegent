import { spawn } from 'node:child_process'

import { rejectRecordedCheckpointFailure } from './checkpoint-result.mjs'

export const HEARTBEAT_INTERVAL_MS = 30_000

export function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function createCheckpointProcessRunner({
  taskFlowPath,
  isolatedXvfbPath,
  platform = process.platform,
  spawnProcess = spawn,
  output = process,
}) {
  let displayStartup = Promise.resolve()
  return async function runTaskFlow(args, env, label) {
    const isolateDisplay = platform === 'linux' && env.WEWORK_E2E_ISOLATED_XVFB === 'true'
    let releaseDisplay = () => {}
    if (isolateDisplay) {
      // xvfb-run's free display selection must not overlap another startup.
      // Release on verified window-manager readiness so test bodies stay parallel.
      const precedingStartup = displayStartup
      displayStartup = new Promise(resolve => {
        releaseDisplay = resolve
      })
      await precedingStartup
    }
    return new Promise((resolvePromise, reject) => {
      const startedAt = Date.now()
      let lastOutputAt = startedAt
      let resultDir = null
      let outputTail = ''
      let stderrTail = ''
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
      const child = spawnProcess(command, commandArgs, {
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
        if (captureStderr) {
          stderrTail = `${stderrTail}${text}`.slice(-12_000)
          if (stderrTail.includes('[desktop-e2e-window-manager] ready:')) releaseDisplay()
        }
      }
      child.stdout.on('data', chunk => forward(chunk, output.stdout))
      child.stderr.on('data', chunk => forward(chunk, output.stderr, true))

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
    }).finally(releaseDisplay)
  }
}
