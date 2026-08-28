import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  macosCodesignIdentityArguments,
  macosCodesignKeychainArguments,
  macosSigningFingerprint,
  signPreparedMacOsBinaries,
} from './lib/deepseek-harness-signing.mjs'

const temporaryDirectories = []

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
