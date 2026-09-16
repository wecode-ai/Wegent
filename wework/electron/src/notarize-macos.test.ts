import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const {
  authorizationArgs,
  formatBytes,
  formatDuration,
  infoArgs,
  isTransientNotaryFailure,
  requireSubmission,
  retryAttempts,
  run,
  s3AccelerationArgs,
  submitArgs,
  waitArgs,
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
  afterSign: config.afterSign,
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

  expect(config.afterSign).toBe(resolve(electronRoot, 'scripts/notarize-macos.cjs'))
  expect(config.notarize).toBe(false)
})

test('builds a signed macOS application without starting notarization', () => {
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
const config = require(process.argv[1])
process.stdout.write(JSON.stringify({
  afterSign: config.afterSign,
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
          WEWORK_SKIP_MACOS_NOTARIZATION: 'true',
        },
      }
    )
  )

  expect(config.afterSign).toBeUndefined()
  expect(config.notarize).toBe(false)
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
  expect(isTransientNotaryFailure(new Error('HTTPClientError.connectTimeout'))).toBe(true)
  expect(isTransientNotaryFailure(new Error('HTTPClientError.deadlineExceeded'))).toBe(true)
  expect(isTransientNotaryFailure(new Error('abortedUpload after connection reset'))).toBe(true)
  expect(isTransientNotaryFailure(new Error('xcrun timed out after 2100000ms'))).toBe(true)
  expect(
    isTransientNotaryFailure(
      new Error('NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."')
    )
  ).toBe(true)
  expect(
    isTransientNotaryFailure(new Error('Apple notarization failed with status: Invalid'))
  ).toBe(false)
})

test('terminates commands that exceed their process timeout', async () => {
  await expect(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 })
  ).rejects.toThrow('timed out after 100ms')
})

test('limits notarization upload attempts', () => {
  expect(retryAttempts(undefined)).toBe(3)
  expect(retryAttempts('5')).toBe(5)
  expect(() => retryAttempts('0')).toThrow('between 1 and 5')
  expect(() => retryAttempts('6')).toThrow('between 1 and 5')
})

test('uses S3 acceleration by default and supports explicit standard S3', () => {
  expect(s3AccelerationArgs(undefined)).toEqual(['--s3-acceleration'])
  expect(s3AccelerationArgs('true')).toEqual(['--s3-acceleration'])
  expect(s3AccelerationArgs('false')).toEqual(['--no-s3-acceleration'])
  expect(() => s3AccelerationArgs('invalid')).toThrow('must be true or false')
})

test('separates notarization upload from the processing wait', () => {
  const environment = {
    APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
    APPLE_API_KEY_ID: 'KEYID',
    APPLE_API_ISSUER: 'issuer',
  }

  expect(submitArgs('/tmp/Wework.zip', environment)).toEqual([
    'notarytool',
    'submit',
    '/tmp/Wework.zip',
    '--key',
    '/tmp/AuthKey_TEST.p8',
    '--key-id',
    'KEYID',
    '--issuer',
    'issuer',
    '--s3-acceleration',
    '--no-wait',
    '--output-format',
    'json',
  ])
  expect(waitArgs('submission-id', environment)).toEqual([
    'notarytool',
    'wait',
    'submission-id',
    '--key',
    '/tmp/AuthKey_TEST.p8',
    '--key-id',
    'KEYID',
    '--issuer',
    'issuer',
    '--timeout',
    '45m',
    '--progress',
  ])
  expect(infoArgs('submission-id', environment)).toEqual([
    'notarytool',
    'info',
    'submission-id',
    '--key',
    '/tmp/AuthKey_TEST.p8',
    '--key-id',
    'KEYID',
    '--issuer',
    'issuer',
    '--output-format',
    'json',
  ])
})

test('requires Apple to return a notarization submission ID', () => {
  expect(requireSubmission({ id: ' submission-id ', status: 'Uploaded' })).toEqual({
    id: 'submission-id',
    status: 'Uploaded',
  })
  expect(() => requireSubmission({ status: 'Uploaded' })).toThrow('without a submission ID')
})

test('formats notarization archive sizes and phase durations for CI logs', () => {
  expect(formatBytes(390_360_297)).toBe('372 MiB')
  expect(formatBytes(1_073_741_824)).toBe('1.0 GiB')
  expect(formatDuration(34 * 60 * 1000 + 11_000)).toBe('34m 11s')
  expect(formatDuration(900)).toBe('1s')
})
