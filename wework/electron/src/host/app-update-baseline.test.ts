import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { readBaseline, saveBaseline } = require('electron-updater/out/WeworkUpdateBaseline.js')
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-baseline-'))
  roots.push(root)
  const file = join(root, 'download.zip')
  const bytes = Buffer.from('verified full application ZIP')
  await writeFile(file, bytes)
  const map = gzipSync(JSON.stringify({ version: '2', files: [] }))
  const info = {
    version: '0.4.1',
    arch: process.arch,
    url: 'https://example.test/WeWork_0.4.1.zip',
    sha512: createHash('sha512').update(bytes).digest('base64'),
  }
  return { root, file, map, info }
}

test('full download persists a verified pair independently of the next artifact name', async () => {
  const { root, file, map, info } = await fixture()
  expect(await readBaseline(root, process.arch)).toBeNull()
  await saveBaseline(root, file, map, info)
  expect((await readBaseline(root, process.arch)).record.url).toBe(info.url)
  expect(await readBaseline(root, 'another-arch')).toBeNull()
  expect(await readFile(join(root, 'update.zip'))).toEqual(await readFile(file))
})

test.each(['update.zip', 'current.blockmap', 'wework-baseline.json'])(
  'refuses a missing or corrupt %s without guessing a remote map',
  async name => {
    const { root, file, map, info } = await fixture()
    await saveBaseline(root, file, map, info)
    await writeFile(join(root, name), 'corrupt')
    expect(await readBaseline(root, process.arch)).toBeNull()
  }
)

test('does not replace the previous baseline when a new ZIP fails integrity validation', async () => {
  const { root, file, map, info } = await fixture()
  await saveBaseline(root, file, map, info)
  await writeFile(file, 'broken')
  await expect(saveBaseline(root, file, map, info)).rejects.toThrow('checksum mismatch')
  expect((await readBaseline(root, process.arch)).record.sha512).toBe(info.sha512)
})
