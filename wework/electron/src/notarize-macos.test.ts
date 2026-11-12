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
  submitArchive,
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

const submissionId = 'cd5196aa-a989-4a83-9866-7c67eaae4738'
const notaryEnvironment = { APPLE_KEYCHAIN_PROFILE: 'test-profile' }

test('uploads once and observes the same submission after a wait transport failure', async () => {
  let now = 0
  let observations = 0
  const execute = vi.fn(async (_command, args: string[]) => {
    if (args[1] === 'submit') return JSON.stringify({ id: submissionId })
    observations += 1
    if (observations === 1) {
      now += 12000
      throw new Error('NSURLErrorDomain Code=-1001 The request timed out')
    }
    return JSON.stringify({ id: submissionId, status: 'Accepted' })
  })
  const wait = vi.fn(async (milliseconds: number) => {
    now += milliseconds
  })
  await expect(
    submitArchive('/tmp/WeWork.zip', notaryEnvironment, {
      execute,
      wait,
      now: () => now,
    })
  ).resolves.toMatchObject({ status: 'Accepted' })
  const calls = execute.mock.calls.map(([, args]) => args)
  expect(calls.filter(args => args[1] === 'submit')).toHaveLength(1)
  expect(calls[0]).not.toContain('--wait')
  expect(calls.slice(1).map(args => args.slice(0, 3))).toEqual([
    ['notarytool', 'wait', submissionId],
    ['notarytool', 'wait', submissionId],
  ])
  expect(calls[1].slice(-2)).toEqual(['--timeout', '1800s'])
  expect(calls[2].slice(-2)).toEqual(['--timeout', '1783s'])
})

test('recovers the observed submission URL instead of uploading the archive again', async () => {
  const execute = vi
    .fn()
    .mockRejectedValueOnce(
      new Error(
        `NSURLErrorDomain Code=-1001 https://appstoreconnect.apple.com/notary/v2/submissions/${submissionId}?`
      )
    )
    .mockResolvedValue(JSON.stringify({ id: submissionId, status: 'Accepted' }))
  await expect(
    submitArchive('/tmp/WeWork.zip', notaryEnvironment, {
      execute,
      wait: vi.fn(),
    })
  ).resolves.toMatchObject({ status: 'Accepted' })
  expect(execute.mock.calls.map(([, args]) => args.slice(0, 3))).toEqual([
    ['notarytool', 'submit', '/tmp/WeWork.zip'],
    ['notarytool', 'wait', submissionId],
  ])
})

test('does not blindly repeat an upload whose submission identity is unknown', async () => {
  const failure = new Error('NSURLErrorDomain Code=-1001 The request timed out')
  const execute = vi.fn().mockRejectedValue(failure)
  await expect(
    submitArchive('/tmp/WeWork.zip', notaryEnvironment, {
      execute,
      wait: vi.fn(),
    })
  ).rejects.toBe(failure)
  expect(execute).toHaveBeenCalledOnce()
})

test('rejects missing submission identity and unrelated error URLs', async () => {
  const execute = vi.fn().mockResolvedValue(JSON.stringify({ status: 'Accepted' }))
  await expect(
    submitArchive('/tmp/WeWork.zip', notaryEnvironment, {
      execute,
      wait: vi.fn(),
    })
  ).rejects.toThrow('no valid submission ID')
  expect(execute).toHaveBeenCalledOnce()
  const failure = new Error(
    `request timed out https://example.com/notary/v2/submissions/${submissionId}?`
  )
  execute.mockReset().mockRejectedValue(failure)
  await expect(
    submitArchive('/tmp/WeWork.zip', notaryEnvironment, {
      execute,
      wait: vi.fn(),
    })
  ).rejects.toBe(failure)
  expect(execute).toHaveBeenCalledOnce()
})

test('preserves terminal rejection and the original total observation budget', async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify({ id: submissionId }))
    .mockResolvedValueOnce(JSON.stringify({ id: submissionId, status: 'Invalid' }))
  await expect(
    submitArchive('/tmp/WeWork.zip', notaryEnvironment, {
      execute,
      wait: vi.fn(),
    })
  ).rejects.toThrow('Apple notarization failed with status: Invalid')

  let now = 0
  execute.mockReset().mockImplementation(async (_command, args: string[]) => {
    if (args[1] === 'submit') return JSON.stringify({ id: submissionId })
    now = 1800000
    throw new Error('NSURLErrorDomain Code=-1001 The request timed out')
  })
  const wait = vi.fn()
  await expect(
    submitArchive('/tmp/WeWork.zip', notaryEnvironment, {
      execute,
      wait,
      now: () => now,
    })
  ).rejects.toThrow('observation budget exhausted')
  expect(execute).toHaveBeenCalledTimes(2)
  expect(wait).not.toHaveBeenCalled()
})
