const { spawn } = require('node:child_process')
const { mkdtemp, rm, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { resolveBuildIdentity } = require('./build-identity.cjs')
const {
  recordReleaseBuildStage,
  isTransientNotaryFailure,
  notaryStatus,
} = require('./release-build-diagnostics.cjs')

async function notarizeMacos(context) {
  if (context.electronPlatformName !== 'darwin') return

  const identity = resolveBuildIdentity()
  const appPath = join(context.appOutDir, `${identity.productName}.app`)
  await notarizeApp(appPath)
}

async function notarizeApp(appPath, environment = process.env) {
  await requireDirectory(appPath)
  if (
    await recordReleaseBuildStage(
      'ticket-lookup',
      () => hasStapledTicket(appPath, environment),
      environment
    )
  )
    return

  const identity = resolveBuildIdentity(environment)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wework-notarize-'))
  const archivePath = join(temporaryDirectory, `${identity.productName}.zip`)
  try {
    await recordReleaseBuildStage(
      'verify-signature',
      () => run('codesign', ['--verify', '--deep', '--strict', appPath]),
      environment
    )
    await recordReleaseBuildStage(
      'archive',
      () => run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archivePath]),
      environment
    )
    await recordReleaseBuildStage(
      'notary-submit',
      () => submitArchive(archivePath, environment),
      environment
    )
    await recordReleaseBuildStage(
      'staple-ticket',
      () => runNotaryCommand(['stapler', 'staple', appPath], environment),
      environment
    )
    await recordReleaseBuildStage(
      'validate-ticket',
      () => runNotaryCommand(['stapler', 'validate', appPath], environment),
      environment
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function submitArchive(archivePath, environment, options = {}) {
  const { execute = run, wait = delay } = options
  const args = [
    'notarytool',
    'submit',
    archivePath,
    ...authorizationArgs(environment),
    ...s3AccelerationArgs(environment.WEWORK_NOTARYTOOL_S3_ACCELERATION),
    '--output-format',
    'json',
  ]
  let id
  try {
    id = submissionId(JSON.parse(await runNotaryCommand(args, environment, execute, wait)).id)
    if (!id) throw new Error('Apple notarization returned no valid submission ID')
  } catch (error) {
    id = knownSubmissionId(error)
    if (!id || !isTransientNotaryFailure(error)) throw error
  }
  console.info('Apple notarization submission:', id)
  return waitForSubmission(id, environment, options)
}

function submissionId(value) {
  return typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined
}

function knownSubmissionId(error) {
  return (
    submissionId(error?.notarySubmissionId) ||
    submissionId(
      String(error?.message || '').match(
        /https:\/\/appstoreconnect\.apple\.com\/notary\/v2\/submissions\/([a-f\d-]{36})(?:\?|\b)/i
      )?.[1]
    )
  )
}

async function waitForSubmission(
  id,
  environment,
  { execute = run, wait = delay, now = Date.now } = {}
) {
  const deadline = now() + 30 * 60 * 1000
  const exhausted = () => new Error(`Apple notarization observation budget exhausted: ${id}`)
  const observe = (command, args) => {
    const seconds = Math.floor((deadline - now()) / 1000)
    if (seconds < 1) throw exhausted()
    return execute(command, [...args, '--timeout', `${seconds}s`])
  }
  const pause = milliseconds => {
    if (now() + milliseconds >= deadline) throw exhausted()
    return wait(milliseconds)
  }
  const result = JSON.parse(
    await runNotaryCommand(
      ['notarytool', 'wait', id, ...authorizationArgs(environment), '--output-format', 'json'],
      environment,
      observe,
      pause
    )
  )
  if (result.status !== 'Accepted') {
    throw Object.assign(
      new Error(`Apple notarization failed with status: ${result.status || 'unknown'}`),
      { notaryStatus: notaryStatus(result.status) }
    )
  }
  return result
}

async function runNotaryCommand(args, environment, execute = run, wait = delay) {
  const limit = retryAttempts(environment.WEWORK_NOTARY_UPLOAD_ATTEMPTS)
  // A transport error can follow a successful upload; never create another job.
  const attempts = args[0] === 'notarytool' && args[1] === 'submit' ? 1 : limit
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await execute('xcrun', args)
    } catch (error) {
      if (!isTransientNotaryFailure(error) || attempt === attempts) throw error
      const delayMs = attempt * 5000
      console.warn(
        `Apple ${args[0]} ${args[1]} transport failed; retrying attempt ${attempt + 1}/${attempts} in ${delayMs / 1000}s`
      )
      await wait(delayMs)
    }
  }
  throw new Error('Apple notarization exhausted all transport attempts')
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

async function hasStapledTicket(appPath, environment, execute = runNotaryCommand) {
  try {
    await execute(['stapler', 'validate', appPath], environment)
    return true
  } catch (error) {
    if (isTransientNotaryFailure(error)) throw error
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

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout)
      } else {
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        const error = Object.assign(
          new Error(
            `${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}${details ? `: ${details}` : ''}`
          ),
          { exitCode: code, signal }
        )
        try {
          const result = JSON.parse(stdout)
          error.notaryStatus = notaryStatus(result.status)
          error.notarySubmissionId = submissionId(result.id)
        } catch {
          // Non-JSON command output has no structured notarization status.
        }
        reject(error)
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
module.exports.isTransientNotaryFailure = isTransientNotaryFailure
module.exports.notarizeApp = notarizeApp
module.exports.retryAttempts = retryAttempts
module.exports.s3AccelerationArgs = s3AccelerationArgs
module.exports.runNotaryCommand = runNotaryCommand
module.exports.hasStapledTicket = hasStapledTicket
module.exports.submitArchive = submitArchive
