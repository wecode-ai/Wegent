import { ZipArchive } from 'archiver'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const roots = []
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'wework-electron-zip-'))
  roots.push(root)
  return root
}

async function archive(path, entries) {
  const zip = new ZipArchive({ zlib: { level: 6 } })
  const complete = pipeline(zip, createWriteStream(path))
  for (const entry of entries) zip.append(entry.bytes, { name: entry.name })
  await zip.finalize()
  await complete
}

async function extractInElectron(path, destination) {
  const script = `
    const extract = require(${JSON.stringify(require.resolve('extract-zip'))})
    let settled = false
    process.once('beforeExit', () => {
      if (!settled) {console.error('ZIP extraction did not settle before Electron became idle'); process.exitCode = 1}
    })
    extract(${JSON.stringify(path)}, {dir:${JSON.stringify(destination)}}).then(
      () => {settled = true; console.log(JSON.stringify({electron:process.versions.electron, completed:true}))},
      error => {settled = true; console.error(error.message); process.exitCode = 1}
    )
  `
  const result = await execute(require('electron'), ['--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 10_000,
  })
  const evidence = JSON.parse(result.stdout.trim())
  expect(evidence.electron).toBe(require('electron/package.json').version)
  expect(evidence.completed).toBe(true)
}

test('finishes all UV-sized ZIP entries in the actual Electron Node runtime', async () => {
  const root = await directory()
  const path = join(root, 'uv.zip')
  const destination = join(root, 'extracted')
  const entries = [
    { name: 'uv.exe', size: 60_217_856 },
    { name: 'uvw.exe', size: 333_312 },
    { name: 'uvx.exe', size: 332_800 },
  ].map(({ name, size }, index) => {
    // Match the real archive's complete sizes while keeping this local fixture compact.
    const bytes = Buffer.alloc(size)
    for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = (offset + index) % 251
    return { name, bytes, sha256: digest(bytes) }
  })
  await archive(path, entries)

  await extractInElectron(path, destination)

  for (const entry of entries) {
    const bytes = await readFile(join(destination, entry.name))
    expect(bytes.byteLength, entry.name).toBe(entry.bytes.byteLength)
    expect(digest(bytes), entry.name).toBe(entry.sha256)
  }
}, 20_000)

test('rejects a parent-directory ZIP entry before writing outside the destination', async () => {
  const root = await directory()
  const path = join(root, 'unsafe.zip')
  await archive(path, [{ name: 'folder/escape.txt', bytes: Buffer.from('boundary probe') }])
  const bytes = await readFile(path)
  await writeFile(
    path,
    Buffer.from(
      bytes.toString('latin1').replaceAll('folder/escape.txt', '../out/escape.txt'),
      'latin1'
    )
  )

  await expect(extractInElectron(path, join(root, 'extracted'))).rejects.toThrow(
    /invalid relative path/
  )

  await expect(readFile(join(root, 'out', 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rejects an existing directory link that escapes the extraction root', async () => {
  const root = await directory()
  const path = join(root, 'linked.zip')
  const destination = join(root, 'extracted')
  const outside = join(root, 'outside')
  await mkdir(destination)
  await mkdir(outside)
  await symlink(outside, join(destination, 'nested'), 'junction')
  await archive(path, [{ name: 'nested/escape.txt', bytes: Buffer.from('boundary probe') }])

  await expect(extractInElectron(path, destination)).rejects.toThrow(/Out of bound path/)

  await expect(readFile(join(outside, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})
