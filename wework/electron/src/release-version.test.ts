import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { resolveReleaseVersion } = require('../scripts/release-version.cjs')
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('uses the package version when no release override is provided', () => {
  expect(resolveReleaseVersion('0.2.7', {})).toBe('0.2.7')
})

test('uses the explicit release version without modifying package metadata', () => {
  expect(
    resolveReleaseVersion('0.2.7', {
      WEWORK_RELEASE_VERSION: ' 0.2.4-beta.1 ',
    })
  ).toBe('0.2.4-beta.1')
})

test('rejects invalid release versions', () => {
  expect(() =>
    resolveReleaseVersion('0.2.7', {
      WEWORK_RELEASE_VERSION: 'beta',
    })
  ).toThrow('Invalid Wework release version')
})

test('passes the release version to electron-builder metadata', () => {
  const metadata = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
const config = require(process.argv[1])
process.stdout.write(JSON.stringify(config.extraMetadata))
`,
        resolve(electronRoot, 'electron-builder.config.cjs'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WEWORK_RELEASE_VERSION: '0.2.4-beta.1',
        },
      }
    )
  )

  expect(metadata.version).toBe('0.2.4-beta.1')
})
