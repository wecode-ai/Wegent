const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

async function recordReleaseBuildStage(stage, execute, environment = process.env) {
  const directory = environment.WEWORK_RELEASE_DIAGNOSTICS_DIR
  if (!directory) return execute()

  const started = performance.now()
  const record = (phase, details = {}) => {
    mkdirSync(directory, { recursive: true })
    appendFileSync(
      join(directory, `stages-${process.pid}.jsonl`),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        stage,
        phase,
        elapsedMs: Math.round(performance.now() - started),
        platform: environment.WEWORK_RELEASE_PLATFORM || process.platform,
        arch: environment.WEWORK_RELEASE_ARCH || process.arch,
        package: environment.WEWORK_ONLINE_UPDATE_BUILD === 'true' ? 'online' : 'installer',
        ...details,
      })}\n`
    )
  }
  record('started')
  try {
    const result = await execute()
    const status = notaryStatus(result?.status)
    record('completed', {
      ...(typeof status === 'string'
        ? {
            notaryStatus: status,
          }
        : {}),
    })
    return result
  } catch (error) {
    record('failed', {
      ...(notaryStatus(error?.notaryStatus)
        ? { notaryStatus: notaryStatus(error.notaryStatus) }
        : {}),
      ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}),
      ...(typeof error?.signal === 'string' && /^SIG[A-Z]+$/.test(error.signal)
        ? { signal: error.signal }
        : {}),
      failure: isTransientNotaryFailure(error) ? 'transport' : 'command-or-validation',
    })
    throw error
  }
}

function isTransientNotaryFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /abortedUpload|deadlineExceeded|timed? ?out|connection (?:reset|lost)|NSURLErrorDomain.*-100[159]/i.test(
    message
  )
}

function notaryStatus(value) {
  if (typeof value !== 'string') return undefined
  return ['Accepted', 'Invalid', 'In Progress'].includes(value) ? value : 'unknown'
}

module.exports = { recordReleaseBuildStage, isTransientNotaryFailure, notaryStatus }
