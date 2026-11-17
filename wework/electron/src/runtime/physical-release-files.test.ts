import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Header } from 'tar'
import { afterEach, expect, test } from 'vitest'
import { extractPhysicalRelease } from './physical-release-files.js'

const require = createRequire(import.meta.url)
// Fixtures and assertions address physical archive bytes in both Node and Electron.
const physicalFs: typeof import('node:fs/promises') = require(
  process.versions.electron ? 'original-fs' : 'node:fs'
).promises
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => physicalFs.rm(root, { recursive: true, force: true }))
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-physical-extraction-'))
  roots.push(root)
  const destination = join(root, 'destination')
  await mkdir(destination)
  return { root, destination, archive: join(root, 'release.tar.gz') }
}

test('extracts physical ASAR files and paths beyond Windows MAX_PATH', async () => {
  const { root, destination, archive } = await fixture()
  const source = join(root, 'source')
  const deep = join(...Array.from({ length: 16 }, (_, index) => `nested-package-${index}`), 'file')
  await mkdir(dirname(join(source, deep)), { recursive: true })
  await mkdir(join(source, 'resources'))
  await writeFile(join(source, deep), 'runtime module')
  await writeFile(join(source, 'resources/app.asar'), 'physical ASAR bytes')
  // Keep the test host's ASAR support intact while the fixture packer reads raw bytes.
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=commonjs',
      '--eval',
      `process.noAsar = true; require(${JSON.stringify(require.resolve('tar'))}).create({
        cwd: ${JSON.stringify(source)}, file: ${JSON.stringify(archive)}, gzip: true
      }, ['.']).catch(error => { console.error(error); process.exitCode = 1 })`,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }
  )

  await extractPhysicalRelease(archive, destination)

  expect(await readFile(join(destination, deep), 'utf8')).toBe('runtime module')
  expect(await physicalFs.readFile(join(destination, 'resources/app.asar'), 'utf8')).toBe(
    'physical ASAR bytes'
  )
})

test('rejects parent traversal without writing outside the destination', async () => {
  const { root, destination, archive } = await fixture()
  const header = new Header({ path: '../escaped', size: 0, type: 'File' })
  header.encode()
  await writeFile(archive, Buffer.concat([header.block!, Buffer.alloc(1024)]))

  await expect(extractPhysicalRelease(archive, destination)).rejects.toThrow()
  await expect(readFile(join(root, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rejects absolute archive paths rather than silently stripping their root', async () => {
  const { destination, archive } = await fixture()
  const header = new Header({ path: '/absolute-archive-entry', size: 0, type: 'File' })
  header.encode()
  await writeFile(archive, Buffer.concat([header.block!, Buffer.alloc(1024)]))

  await expect(extractPhysicalRelease(archive, destination)).rejects.toThrow()
})

test('rejects extraction through an archive symlink pointing outside the destination', async () => {
  const { root, destination, archive } = await fixture()
  const outside = join(root, 'outside')
  await mkdir(outside)
  const link = new Header({ path: 'link', type: 'SymbolicLink', linkpath: '../outside', size: 0 })
  const file = new Header({ path: 'link/escaped', type: 'File', size: 0 })
  link.encode()
  file.encode()
  await writeFile(archive, Buffer.concat([link.block!, file.block!, Buffer.alloc(1024)]))

  await expect(extractPhysicalRelease(archive, destination)).rejects.toThrow()
  await expect(readFile(join(outside, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' })
})
