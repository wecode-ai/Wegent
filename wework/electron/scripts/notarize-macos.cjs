const { spawn } = require('node:child_process')
const { mkdtemp, rm, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { resolveBuildIdentity } = require('./build-identity.cjs')

const NOTARYTOOL_UPLOAD_TIMEOUT_MS = 35 * 60 * 1000
const NOTARYTOOL_WAIT_TIMEOUT = '45m'
const NOTARYTOOL_WAIT_PROCESS_TIMEOUT_MS = 50 * 60 * 1000
const NOTARYTOOL_STATUS_TIMEOUT_MS = 2 * 60 * 1000

async function notarizeMacos(context) {
  if (context.electronPlatformName !== 'darwin') return

  const identity = resolveBuildIdentity()
  const appPath = join(context.appOutDir, `${identity.productName}.app`)
  await notarizeApp(appPath)
}

async function notarizeApp(appPath, environment = process.env) {
  await requireDirectory(appPath)
  if (await hasStapledTicket(appPath)) return

  const identity = resolveBuildIdentity(environment)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wework-notarize-'))
  const archivePath = join(temporaryDirectory, `${identity.productName}.zip`)
  try {
    const verificationStartedAt = Date.now()
    console.log(`Apple notarization code-signature verification started: ${appPath}`)
    await run('codesign', ['--verify', '--deep', '--strict', appPath])
    console.log(
      `Apple notarization code-signature verification completed in ${formatDuration(
        Date.now() - verificationStartedAt
      )}`
    )

    const compressionStartedAt = Date.now()
    console.log(`Apple notarization archive compression started: ${archivePath}`)
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archivePath])
    const archiveBytes = (await stat(archivePath)).size
    console.log(
      `Apple notarization archive ready: ${formatBytes(archiveBytes)} ` +
        `(${archiveBytes} bytes), compressed in ${formatDuration(Date.now() - compressionStartedAt)}`
    )

    const submission = await submitArchive(archivePath, environment)
    const result = await waitForSubmission(submission.id, environment)
    if (result.status !== 'Accepted') {
      throw new Error(`Apple notarization failed with status: ${result.status || 'unknown'}`)
    }

    const stapleStartedAt = Date.now()
    console.log('Apple notarization ticket staple and validation started')
    await run('xcrun', ['stapler', 'staple', appPath])
    await run('xcrun', ['stapler', 'validate', appPath])
    console.log(
      `Apple notarization ticket staple and validation completed in ${formatDuration(
        Date.now() - stapleStartedAt
      )}`
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function submitArchive(archivePath, environment) {
  const attempts = retryAttempts(environment.WEWORK_NOTARY_UPLOAD_ATTEMPTS)
  const archiveBytes = (await stat(archivePath)).size
  const args = submitArgs(archivePath, environment)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStartedAt = Date.now()
    try {
      console.log(
        `Apple notarization upload attempt ${attempt}/${attempts} started: ` +
          `${formatBytes(archiveBytes)} (${archiveBytes} bytes)`
      )
      const result = JSON.parse(
        await run('xcrun', args, {
          streamOutput: true,
          timeoutMs: NOTARYTOOL_UPLOAD_TIMEOUT_MS,
        })
      )
      const submission = requireSubmission(result)
      console.log(
        `Apple notarization upload attempt ${attempt}/${attempts} completed in ` +
          `${formatDuration(Date.now() - attemptStartedAt)}: submission ${submission.id}`
      )
      return submission
    } catch (error) {
      if (!isTransientNotaryFailure(error) || attempt === attempts) throw error
      const delayMs = attempt * 5000
      console.warn(
        `Apple notarization upload failed transiently; retrying attempt ${attempt + 1}/${attempts} in ${delayMs / 1000}s`
      )
      await delay(delayMs)
    }
  }
  throw new Error('Apple notarization exhausted all upload attempts')
}

async function waitForSubmission(submissionId, environment) {
  const waitStartedAt = Date.now()
  console.log(
    `Apple notarization processing wait started: submission ${submissionId}, ` +
      `timeout ${NOTARYTOOL_WAIT_TIMEOUT}`
  )
  try {
    await run('xcrun', waitArgs(submissionId, environment), {
      streamOutput: true,
      timeoutMs: NOTARYTOOL_WAIT_PROCESS_TIMEOUT_MS,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Apple notarization processing wait failed for submission ${submissionId}: ${message}`
    )
  }

  const result = JSON.parse(
    await run('xcrun', infoArgs(submissionId, environment), {
      timeoutMs: NOTARYTOOL_STATUS_TIMEOUT_MS,
    })
  )
  console.log(
    `Apple notarization processing wait completed in ` +
      `${formatDuration(Date.now() - waitStartedAt)}: submission ${submissionId}, ` +
      `status ${result.status || 'unknown'}`
  )
  return result
}

function submitArgs(archivePath, environment) {
  return [
    'notarytool',
    'submit',
    archivePath,
    ...authorizationArgs(environment),
    ...s3AccelerationArgs(environment.WEWORK_NOTARYTOOL_S3_ACCELERATION),
    '--no-wait',
    '--output-format',
    'json',
  ]
}

function waitArgs(submissionId, environment) {
  return [
    'notarytool',
    'wait',
    submissionId,
    ...authorizationArgs(environment),
    '--timeout',
    NOTARYTOOL_WAIT_TIMEOUT,
    '--progress',
  ]
}

function infoArgs(submissionId, environment) {
  return [
    'notarytool',
    'info',
    submissionId,
    ...authorizationArgs(environment),
    '--output-format',
    'json',
  ]
}

function requireSubmission(result) {
  const id = typeof result?.id === 'string' ? result.id.trim() : ''
  if (!id) {
    throw new Error('Apple notarization upload completed without a submission ID')
  }
  return { ...result, id }
}

function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Invalid byte count: ${bytes}`)
  }
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 || unit === 'B' ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`Invalid duration: ${milliseconds}`)
  }
  const totalSeconds = Math.round(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function authorizationArgs(environment) {
  const apiKey = environment.APPLE_API_KEY?.trim()
  const apiKeyId = environment.APPLE_API_KEY_ID?.trim()
  const apiIssuer = environment.APPLE_API_ISSUER?.trim()
  if (apiKey || apiKeyId || apiIssuer) {
    if (!apiKey || !apiKeyId || !apiIssuer) {
      throw new Error('APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER are required')
    }
    return ['--key', apiKey, '--key-id', apiKeyId, '--issuer', apiIssuer]
  }

  const appleId = environment.APPLE_ID?.trim()
  const password = environment.APPLE_APP_SPECIFIC_PASSWORD?.trim()
  const teamId = environment.APPLE_TEAM_ID?.trim()
  if (appleId || password || teamId) {
    if (!appleId || !password || !teamId) {
      throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are required')
    }
    return ['--apple-id', appleId, '--password', password, '--team-id', teamId]
  }

  const keychainProfile = environment.APPLE_KEYCHAIN_PROFILE?.trim()
  const keychain = environment.APPLE_KEYCHAIN?.trim()
  if (keychainProfile) {
    return ['--keychain-profile', keychainProfile, ...(keychain ? ['--keychain', keychain] : [])]
  }
  throw new Error('Apple notarization credentials are required')
}

function retryAttempts(value) {
  if (value === undefined || value === '') return 3
  const attempts = Number(value)
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error('WEWORK_NOTARY_UPLOAD_ATTEMPTS must be an integer between 1 and 5')
  }
  return attempts
}

function s3AccelerationArgs(value) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === 'true') return ['--s3-acceleration']
  if (normalized === 'false') return ['--no-s3-acceleration']
  throw new Error('WEWORK_NOTARYTOOL_S3_ACCELERATION must be true or false')
}

function isTransientNotaryFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /abortedUpload|deadlineExceeded|timed? ?out|connection (?:reset|lost)|NSURLErrorDomain.*-100[159]/i.test(
    message
  )
}

async function hasStapledTicket(appPath) {
  try {
    await run('xcrun', ['stapler', 'validate', appPath])
    return true
  } catch {
    return false
  }
}

async function requireDirectory(path) {
  if (!(await stat(path).catch(() => null))?.isDirectory()) {
    throw new Error(`Signed macOS application is missing: ${path}`)
  }
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKillTimer
    const timeoutTimer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
        }, options.timeoutMs)
      : undefined
    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (options.streamOutput) process.stdout.write(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
      if (options.streamOutput) process.stderr.write(chunk)
    })
    child.once('error', error => {
      clearTimers()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimers()
      if (timedOut) {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`))
        return
      }
      if (code === 0) {
        resolvePromise(stdout)
      } else {
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        reject(
          new Error(
            `${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}${details ? `: ${details}` : ''}`
          )
        )
      }
    })
  })
}

if (require.main === module) {
  const appPath = process.argv[2]
  if (!appPath) {
    console.error('Usage: node notarize-macos.cjs <signed-app-path>')
    process.exitCode = 1
  } else {
    notarizeApp(resolve(appPath)).catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
  }
}

module.exports = notarizeMacos
module.exports.authorizationArgs = authorizationArgs
module.exports.formatBytes = formatBytes
module.exports.formatDuration = formatDuration
module.exports.infoArgs = infoArgs
module.exports.isTransientNotaryFailure = isTransientNotaryFailure
module.exports.notarizeApp = notarizeApp
module.exports.requireSubmission = requireSubmission
module.exports.retryAttempts = retryAttempts
module.exports.run = run
module.exports.s3AccelerationArgs = s3AccelerationArgs
module.exports.submitArgs = submitArgs
module.exports.waitArgs = waitArgs
