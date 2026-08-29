const { spawn } = require('node:child_process')
const { mkdtemp, rm, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { resolveBuildIdentity } = require('./build-identity.cjs')

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
    await run('codesign', ['--verify', '--deep', '--strict', appPath])
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archivePath])
    const result = await submitArchive(archivePath, environment)
    if (result.status !== 'Accepted') {
      throw new Error(`Apple notarization failed with status: ${result.status || 'unknown'}`)
    }
    await run('xcrun', ['stapler', 'staple', appPath])
    await run('xcrun', ['stapler', 'validate', appPath])
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function submitArchive(archivePath, environment) {
  const attempts = retryAttempts(environment.WEWORK_NOTARY_UPLOAD_ATTEMPTS)
  const args = [
    'notarytool',
    'submit',
    archivePath,
    ...authorizationArgs(environment),
    ...s3AccelerationArgs(environment.WEWORK_NOTARYTOOL_S3_ACCELERATION),
    '--wait',
    '--timeout',
    '30m',
    '--output-format',
    'json',
  ]
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return JSON.parse(await run('xcrun', args))
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
  return /abortedUpload|deadlineExceeded|timed? ?out|connection (?:reset|lost)|NSURLErrorDomain.*-100[15]/i.test(
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
module.exports.isTransientNotaryFailure = isTransientNotaryFailure
module.exports.notarizeApp = notarizeApp
module.exports.retryAttempts = retryAttempts
module.exports.s3AccelerationArgs = s3AccelerationArgs
