import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  executeMacOsCodesign,
  macosCodesignIdentityArguments,
  macosCodesignKeychainArguments,
  macosSigningFingerprint,
  signPreparedMacOsBinaries,
} from './lib/deepseek-harness-signing.mjs'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    stat: async (...args) => {
      const metadata = await actual.stat(...args)
      // Model macOS executable permissions that Windows file metadata cannot expose.
      if (process.platform === 'win32' && path.basename(String(args[0])) === 'node')
        metadata.mode |= 0o111
      return metadata
    },
  }
})

const temporaryDirectories = []

describe('executeMacOsCodesign', () => {
  const args = [
    '--force',
    '--sign',
    'Developer ID Application: Example',
    '--timestamp',
    '--options',
    'runtime',
    '--preserve-metadata=entitlements',
    '/private/component',
  ]
  const timestampError = (message = 'The timestamp service is not available.') =>
    Object.assign(new Error('codesign failed'), {
      stderr: `/private/component: replacing existing signature\n/private/component: ${message}\n`,
    })

  test.each([
    'The timestamp service is not available.',
    'A timestamp was expected but was not found.',
  ])('repeats identical signing arguments for %s', async message => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(timestampError(message))
      .mockRejectedValueOnce(timestampError(message))
      .mockResolvedValue('signed')
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const logger = vi.fn()
    await expect(
      executeMacOsCodesign(args, { execute, cwd: '/private', sleepImpl, logger })
    ).resolves.toBe('signed')
    expect(execute.mock.calls).toEqual(Array(3).fill(['codesign', args, '/private']))
    expect(sleepImpl.mock.calls).toEqual([[1_000], [2_000]])
    expect(logger.mock.calls).toEqual([
      ['[codesign] timestamp-service-unavailable attempt=1/3'],
      ['[codesign] timestamp-service-unavailable attempt=2/3'],
    ])
  })

  test.each([
    'The timestamp service is not available.',
    'A timestamp was expected but was not found.',
  ])('preserves the final service failure after exhausting attempts for %s', async message => {
    const error = timestampError(message)
    const execute = vi.fn().mockRejectedValue(error)
    await expect(
      executeMacOsCodesign(args, {
        execute,
        sleepImpl: vi.fn().mockResolvedValue(undefined),
        logger: vi.fn(),
      })
    ).rejects.toBe(error)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  test.each([
    ['permission denied', args],
    ['errSecInternalComponent', args],
    ['The timestamp service is not available.\ninvalid signature', args],
    ['invalid signature\nA timestamp was expected but was not found.', args],
    ['A timestamp was expected but was not found.\ninvalid signature', args],
    ['A timestamp was expected but was not found.', ['--verify', '--strict', '/private/component']],
    ['A timestamp was expected but was not found.', ['--sign', 'identity', '/private/component']],
    ['The timestamp service is not available.', ['--verify', '--strict', '/private/component']],
    ['The timestamp service is not available.', ['--sign', 'identity', '/private/component']],
  ])(
    'rejects %s immediately when the operation is not recoverable',
    async (stderr, commandArgs) => {
      const error = Object.assign(new Error('codesign failed'), { stderr })
      const execute = vi.fn().mockRejectedValue(error)
      const sleepImpl = vi.fn()
      await expect(
        executeMacOsCodesign(commandArgs, { execute, sleepImpl, logger: vi.fn() })
      ).rejects.toBe(error)
      expect(execute).toHaveBeenCalledOnce()
      expect(sleepImpl).not.toHaveBeenCalled()
    }
  )
})

async function createTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wework-deepseek-signing-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('macosSigningFingerprint', () => {
  test('changes when the signing identity changes', () => {
    expect(macosSigningFingerprint('darwin', 'Developer ID Application: One')).not.toBe(
      macosSigningFingerprint('darwin', 'Developer ID Application: Two')
    )
  })

  test('uses the unsigned variant without a macOS signing identity', () => {
    expect(macosSigningFingerprint('linux', 'Developer ID Application: One')).toBe('unsigned')
    expect(macosSigningFingerprint('darwin', '')).toBe('unsigned')
  })
})

describe('macosCodesignKeychainArguments', () => {
  test('selects an explicit keychain for release signing', () => {
    expect(macosCodesignKeychainArguments(' /tmp/signing.keychain-db ')).toEqual([
      '--keychain',
      '/tmp/signing.keychain-db',
    ])
  })

  test('uses the default keychain search list when no path is configured', () => {
    expect(macosCodesignKeychainArguments()).toEqual([])
  })
})

describe('macosCodesignIdentityArguments', () => {
  test('selects the keychain before resolving the signing identity', () => {
    expect(
      macosCodesignIdentityArguments(
        'Developer ID Application: Example',
        '/tmp/signing.keychain-db'
      )
    ).toEqual([
      '--keychain',
      '/tmp/signing.keychain-db',
      '--sign',
      'Developer ID Application: Example',
    ])
  })
})

describe('signPreparedMacOsBinaries', () => {
  test('signs Mach-O executables and native modules before archiving', async () => {
    const directory = await createTemporaryDirectory()
    const nodeBinary = path.join(directory, 'node')
    const nativeModule = path.join(directory, 'node_modules', 'addon.node')
    const script = path.join(directory, 'script.js')
    await mkdir(path.dirname(nativeModule), { recursive: true })
    await Promise.all([
      writeFile(nodeBinary, 'node'),
      writeFile(nativeModule, 'addon'),
      writeFile(script, 'script'),
    ])
    await chmod(nodeBinary, 0o755)

    const commands = []
    const execute = async (command, args) => {
      commands.push([command, args])
      if (command === 'file') {
        return args[1] === script ? 'JavaScript source' : 'Mach-O 64-bit bundle arm64'
      }
      return ''
    }

    const signed = await signPreparedMacOsBinaries(directory, {
      platform: 'darwin',
      identity: 'Developer ID Application: Example',
      keychainPath: '/tmp/signing.keychain-db',
      execute,
      logger: () => {},
    })

    expect(signed).toEqual([nativeModule, nodeBinary].sort())
    const codesignCommands = commands.filter(([command]) => command === 'codesign')
    expect(codesignCommands).toHaveLength(2)
    for (const [, args] of codesignCommands) {
      expect(args).toEqual(
        expect.arrayContaining([
          '--timestamp',
          '--options',
          'runtime',
          '--keychain',
          '/tmp/signing.keychain-db',
          '--sign',
          'Developer ID Application: Example',
        ])
      )
    }
  })

  test('does nothing outside signed macOS builds', async () => {
    const directory = await createTemporaryDirectory()
    await writeFile(path.join(directory, 'addon.node'), 'addon')
    const execute = async () => {
      throw new Error('commands must not run')
    }

    await expect(
      signPreparedMacOsBinaries(directory, {
        platform: 'linux',
        identity: 'Developer ID Application: Example',
        execute,
      })
    ).resolves.toEqual([])
  })
})
