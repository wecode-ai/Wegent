import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const {
  authorizationArgs,
  isTransientNotaryFailure,
  retryAttempts,
  s3AccelerationArgs,
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
    isTransientNotaryFailure(new Error('Apple notarization failed with status: Invalid'))
  ).toBe(false)
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
