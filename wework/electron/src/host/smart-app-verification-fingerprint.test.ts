import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  fingerprintSmartAppDirectory,
  type SmartAppFingerprintPurpose,
} from './smart-app-verification-fingerprint.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('fingerprintSmartAppDirectory', () => {
  test('is independent of traversal order and mtimes', async () => {
    const first = await fixture([
      ['src/index.ts', 'export const value = 1\n'],
      ['package.json', '{"name":"fixture"}\n'],
    ])
    const second = await fixture([
      ['package.json', '{"name":"fixture"}\n'],
      ['src/index.ts', 'export const value = 1\n'],
    ])
    await utimes(join(first, 'src/index.ts'), new Date(1_000), new Date(1_000))
    await utimes(join(second, 'src/index.ts'), new Date(2_000), new Date(2_000))

    await expect(fingerprintSmartAppDirectory(first, 'verification-input')).resolves.toBe(
      await fingerprintSmartAppDirectory(second, 'verification-input')
    )
  })

  test.each([
    'src/index.ts',
    'plugin-manifest.json',
    'package.json',
    'packages/bundle/fixture/cordis.patch.yml',
    'smart-app.verify.json',
  ])('invalidates verification when %s changes', async changedFile => {
    const root = await completeFixture()
    const before = await fingerprintSmartAppDirectory(root, 'verification-input')

    await writeFile(join(root, changedFile), `changed: ${changedFile}\n`)

    await expect(fingerprintSmartAppDirectory(root, 'verification-input')).resolves.not.toBe(before)
  })

  test('ignores operational state, generated archives, build output, and documentation for verification', async () => {
    const root = await completeFixture()
    const before = await fingerprintSmartAppDirectory(root, 'verification-input')
    await writeFiles(root, [
      ['.git/index', 'git state'],
      ['node_modules/dependency/index.js', 'dependency cache'],
      ['test-results/smart-app/report.json', 'report'],
      ['dist/index.js', 'generated output'],
      ['build/client.js', 'generated output'],
      ['release.zip', 'archive'],
      ['README.md', '# Documentation\n'],
      ['docs/guide.md', '# Guide\n'],
    ])

    await expect(fingerprintSmartAppDirectory(root, 'verification-input')).resolves.toBe(before)
  })

  test('includes documentation and build artifacts in the deliverable fingerprint', async () => {
    const root = await completeFixture()
    const before = await fingerprintSmartAppDirectory(root, 'deliverable')

    await writeFiles(root, [
      ['README.md', '# Documentation\n'],
      ['dist/index.js', 'generated output'],
    ])

    await expect(fingerprintSmartAppDirectory(root, 'deliverable')).resolves.not.toBe(before)
  })

  test('excludes development contracts from the deliverable fingerprint', async () => {
    const root = await completeFixture()
    const before = await fingerprintSmartAppDirectory(root, 'deliverable')

    await writeFiles(root, [['smart-app.verify.json', '{"schemaVersion":2}\n']])

    await expect(fingerprintSmartAppDirectory(root, 'deliverable')).resolves.toBe(before)
  })

  test.each<SmartAppFingerprintPurpose>(['verification-input', 'deliverable'])(
    'does not read sensitive files for %s fingerprints',
    async purpose => {
      const root = await completeFixture()
      const before = await fingerprintSmartAppDirectory(root, purpose)
      await writeFiles(root, [
        ['.env.local', 'TOKEN=secret\n'],
        ['private.pem', 'secret\n'],
        ['signing.key', 'secret\n'],
      ])

      await expect(fingerprintSmartAppDirectory(root, purpose)).resolves.toBe(before)
    }
  )

  test.each<SmartAppFingerprintPurpose>(['verification-input', 'deliverable'])(
    'rejects symbolic links for %s',
    async purpose => {
      const root = await completeFixture()
      const outside = await fixture([['secret.txt', 'outside']])
      await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'))

      await expect(fingerprintSmartAppDirectory(root, purpose)).rejects.toMatchObject({
        code: 'SA-PACKAGE-SYMLINK',
      })
    }
  )
})

async function completeFixture(): Promise<string> {
  return fixture([
    ['src/index.ts', 'export const value = 1\n'],
    ['plugin-manifest.json', '{"name":"fixture"}\n'],
    ['package.json', '{"name":"fixture","dependencies":{"zod":"4.4.3"}}\n'],
    ['packages/bundle/fixture/cordis.patch.yml', '[]\n'],
    ['smart-app.verify.json', '{"schemaVersion":1}\n'],
  ])
}

async function fixture(files: Array<[string, string]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-fingerprint-'))
  roots.push(root)
  await writeFiles(root, files)
  return root
}

async function writeFiles(root: string, files: Array<[string, string]>): Promise<void> {
  for (const [relativePath, content] of files) {
    const path = join(root, relativePath)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
}
