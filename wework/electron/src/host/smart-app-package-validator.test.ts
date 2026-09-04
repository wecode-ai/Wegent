import { ZipArchive } from 'archiver'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import {
  extractSmartAppArchive,
  findSmartAppManifestRoot,
  validateSmartAppManifest,
  validateSmartAppPackageDirectory,
} from './smart-app-package-validator.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Smart App package validator', () => {
  test('validates a package directory and returns a deterministic content hash', async () => {
    const root = await packageDirectory()

    const first = await validateSmartAppPackageDirectory(root)
    const second = await validateSmartAppPackageDirectory(root)

    expect(first).toMatchObject({ path: await realpath(root), manifest: { name: 'fixture-app' } })
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(second.sha256).toBe(first.sha256)
  })

  test('rejects escaping, duplicate and inconsistent package declarations', () => {
    expect(() =>
      validateSmartAppManifest({
        ...validManifest(),
        entry: { installPackage: '../outside', profile: 'fixture' },
      })
    ).toThrowError(expect.objectContaining({ code: 'SA-MANIFEST-ENTRY' }))

    expect(() =>
      validateSmartAppManifest({
        ...validManifest(),
        packages: [
          { name: 'fixture-plugin', role: 'profile-bundle', path: 'app' },
          { name: 'fixture-plugin', role: 'extension', path: 'other' },
        ],
      })
    ).toThrowError(expect.objectContaining({ code: 'SA-MANIFEST-PACKAGE' }))

    expect(() =>
      validateSmartAppManifest({
        ...validManifest(),
        plugins: [{ spec: 'pkg' }, { spec: 'pkg' }],
      })
    ).toThrowError(expect.objectContaining({ code: 'SA-MANIFEST-PLUGIN' }))
  })

  test('requires declared local package and plugin paths to exist', async () => {
    const root = await packageDirectory()
    const manifest = validManifest()
    manifest.plugins = [{ spec: 'file:plugins/local', path: 'plugins/local' }]
    await writeManifest(root, manifest)

    await expect(validateSmartAppPackageDirectory(root)).rejects.toMatchObject({
      code: 'SA-MANIFEST-PATH-MISSING',
    })
  })

  test.each(['.env', '.env.local', 'private.pem', 'private.key'])(
    'rejects sensitive package file %s',
    async filename => {
      const root = await packageDirectory()
      await writeFile(join(root, filename), 'secret')

      await expect(validateSmartAppPackageDirectory(root)).rejects.toMatchObject({
        code: 'SA-PACKAGE-SENSITIVE-FILE',
      })
    }
  )

  test('rejects symbolic links and directories over the extracted size limit', async () => {
    const root = await packageDirectory()
    const outside = join(root, '..', 'outside.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, join(root, 'linked.txt'))

    await expect(validateSmartAppPackageDirectory(root)).rejects.toMatchObject({
      code: 'SA-PACKAGE-SYMLINK',
    })

    await rm(join(root, 'linked.txt'))
    await expect(
      validateSmartAppPackageDirectory(root, { maxExtractedBytes: 1 })
    ).rejects.toMatchObject({ code: 'SA-PACKAGE-EXTRACTED-SIZE' })
  })

  test('limits ZIP size and accepts only one root-level or single-wrapper manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-archive-'))
    roots.push(root)
    const source = await packageDirectory(join(root, 'source'))
    const archive = join(root, 'fixture.zip')
    await zipDirectory(source, archive)

    await expect(
      extractSmartAppArchive(archive, join(root, 'too-small'), { maxArchiveBytes: 1 })
    ).rejects.toMatchObject({ code: 'SA-PACKAGE-ARCHIVE-SIZE' })

    const extracted = join(root, 'extracted')
    await extractSmartAppArchive(archive, extracted)
    await expect(findSmartAppManifestRoot(extracted)).resolves.toBe(extracted)

    await mkdir(join(extracted, 'nested', 'second'), { recursive: true })
    await writeManifest(join(extracted, 'nested', 'second'), validManifest())
    await expect(findSmartAppManifestRoot(extracted)).rejects.toMatchObject({
      code: 'SA-PACKAGE-MANIFEST-COUNT',
    })
  })
})

async function packageDirectory(path?: string): Promise<string> {
  const root = path ?? (await mkdtemp(join(tmpdir(), 'wework-smart-app-package-')))
  roots.push(root)
  await mkdir(join(root, 'app'), { recursive: true })
  await writeManifest(root, validManifest())
  await writeFile(
    join(root, 'app', 'package.json'),
    `${JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' })}\n`
  )
  return root
}

async function writeManifest(root: string, manifest: WorkbenchAppManifest): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'plugin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function validManifest(): WorkbenchAppManifest {
  return {
    name: 'fixture-app',
    displayName: 'Fixture App',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Smart app fixture',
    packages: [{ name: 'fixture-plugin', role: 'profile-bundle', path: 'app' }],
    entry: { installPackage: 'app', profile: 'fixture' },
    requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
  }
}

async function zipDirectory(source: string, destination: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destination)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(source, false)
    void archive.finalize()
  })
}
