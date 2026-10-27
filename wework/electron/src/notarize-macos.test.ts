import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  authorizationArgs,
  isTransientNotaryFailure,
  retryAttempts,
  s3AccelerationArgs,
  runNotaryCommand,
  hasStapledTicket,
} = require('../scripts/notarize-macos.cjs')
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('enables the custom notarization hook without embedding credentials', () => {
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
const config = require(process.argv[1])
process.stdout.write(JSON.stringify({
  afterSign: typeof config.afterSign,
  notarize: config.mac.notarize,
}))
`,
        resolve(electronRoot, 'electron-builder.config.cjs'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WEWORK_CUSTOM_MACOS_NOTARIZATION: 'true',
        },
      }
    )
  )

  expect(config.afterSign).toBe('function')
  expect(config.notarize).toBe(false)
})

test('the shared signing hook delegates macOS notarization to its existing implementation', async () => {
  const module = require.cache[require.resolve('../scripts/notarize-macos.cjs')]!
  const original = module.exports
  const notarize = vi.fn().mockResolvedValue(undefined)
  module.exports = notarize
  vi.stubEnv('WEWORK_CUSTOM_MACOS_NOTARIZATION', 'true')
  try {
    const context = { electronPlatformName: 'darwin' }
    await require('../scripts/after-sign.cjs')(context)
    expect(notarize).toHaveBeenCalledExactlyOnceWith(context)
  } finally {
    module.exports = original
    vi.unstubAllEnvs()
  }
})

test('builds notarytool API key authorization for CI', () => {
  expect(
    authorizationArgs({
      APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
      APPLE_API_KEY_ID: 'KEYID',
      APPLE_API_ISSUER: 'issuer',
    })
  ).toEqual(['--key', '/tmp/AuthKey_TEST.p8', '--key-id', 'KEYID', '--issuer', 'issuer'])
})

test('builds notarytool password authorization without changing credentials', () => {
  expect(
    authorizationArgs({
      APPLE_ID: 'developer@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'TEAMID',
    })
  ).toEqual([
    '--apple-id',
    'developer@example.com',
    '--password',
    'app-password',
    '--team-id',
    'TEAMID',
  ])
})

test('retries only transient notarization transport failures', () => {
  expect(isTransientNotaryFailure(new Error('HTTPClientError.deadlineExceeded'))).toBe(true)
  expect(isTransientNotaryFailure(new Error('abortedUpload after connection reset'))).toBe(true)
  expect(
    isTransientNotaryFailure(
      new Error('NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."')
    )
  ).toBe(true)
  expect(
    isTransientNotaryFailure(new Error('Apple notarization failed with status: Invalid'))
  ).toBe(false)
})

test('limits notarization upload attempts', () => {
  expect(retryAttempts(undefined)).toBe(3)
  expect(retryAttempts('5')).toBe(5)
  expect(() => retryAttempts('0')).toThrow('between 1 and 5')
  expect(() => retryAttempts('6')).toThrow('between 1 and 5')
})

test.each(['staple', 'validate'])(
  'recovers %s from the observed Apple CloudKit transport failure',
  async action => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'xcrun exited with code 68: NSURLErrorDomain Code=-1005 "The network connection was lost."'
        )
      )
      .mockResolvedValue('The validate action worked!')
    const wait = vi.fn().mockResolvedValue(undefined)
    const args = ['stapler', action, '/tmp/WeWork.app']

    await expect(runNotaryCommand(args, {}, execute, wait)).resolves.toBe(
      'The validate action worked!'
    )
    expect(execute).toHaveBeenNthCalledWith(1, 'xcrun', args)
    expect(execute).toHaveBeenNthCalledWith(2, 'xcrun', args)
    expect(wait).toHaveBeenCalledExactlyOnceWith(5000)
  }
)

test('preserves ticket rejection and exhausts bounded transport failures', async () => {
  const invalid = new Error('xcrun exited with code 68: The validate action failed!')
  const execute = vi.fn().mockRejectedValue(invalid)
  const wait = vi.fn().mockResolvedValue(undefined)
  const args = ['stapler', 'validate', '/tmp/WeWork.app']
  await expect(runNotaryCommand(args, {}, execute, wait)).rejects.toBe(invalid)
  expect(execute).toHaveBeenCalledOnce()
  expect(wait).not.toHaveBeenCalled()

  execute.mockClear()
  const transport = new Error('NSURLErrorDomain Code=-1005 "The network connection was lost."')
  execute.mockRejectedValue(transport)
  await expect(
    runNotaryCommand(args, { WEWORK_NOTARY_UPLOAD_ATTEMPTS: '3' }, execute, wait)
  ).rejects.toBe(transport)
  expect(execute).toHaveBeenCalledTimes(3)
  expect(wait.mock.calls).toEqual([[5000], [10000]])
})

test('does not mistake a failed ticket lookup for a missing ticket', async () => {
  const transport = new Error('NSURLErrorDomain Code=-1005 "The network connection was lost."')
  const execute = vi.fn().mockRejectedValue(transport)
  await expect(hasStapledTicket('/tmp/WeWork.app', {}, execute)).rejects.toBe(transport)
  execute.mockRejectedValue(new Error('WeWork.app does not have a ticket stapled to it.'))
  await expect(hasStapledTicket('/tmp/WeWork.app', {}, execute)).resolves.toBe(false)
  execute.mockResolvedValue('The validate action worked!')
  await expect(hasStapledTicket('/tmp/WeWork.app', {}, execute)).resolves.toBe(true)
})

test('uses S3 acceleration by default and supports explicit standard S3', () => {
  expect(s3AccelerationArgs(undefined)).toEqual(['--s3-acceleration'])
  expect(s3AccelerationArgs('true')).toEqual(['--s3-acceleration'])
  expect(s3AccelerationArgs('false')).toEqual(['--no-s3-acceleration'])
  expect(() => s3AccelerationArgs('invalid')).toThrow('must be true or false')
})
