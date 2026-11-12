import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { relocateLinks, relocatePath } from './installed-source-preparation.mjs'

// Capture only the shipped CLI's initial output, before any app or task runs.
// Regular files are copied, never hard-linked across mutable checkpoint profiles.
async function copyTree(source, target) {
  const files = []
  async function collect(fromRoot, toRoot) {
    await mkdir(toRoot)
    for (const entry of await readdir(fromRoot, { withFileTypes: true })) {
      const from = join(fromRoot, entry.name),
        to = join(toRoot, entry.name)
      if (entry.isSymbolicLink())
        await symlink(await readlink(from), to, process.platform === 'win32' ? 'junction' : 'dir')
      else if (entry.isDirectory()) await collect(from, to)
      else {
        assert.ok(entry.isFile(), 'Source preparation contains a special file')
        files.push([from, to])
      }
    }
  }
  await mkdir(dirname(target), { recursive: true })
  await collect(source, target)
  for (let offset = 0; offset < files.length; offset += 8) {
    const results = await Promise.allSettled(
      files.slice(offset, offset + 8).map(([from, to]) => copyFile(from, to))
    )
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}

async function treeHash(root) {
  const hash = createHash('sha256')
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(directory, entry.name)
      const name = `${prefix}/${entry.name}`
      hash.update(
        JSON.stringify([
          name,
          entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file',
        ])
      )
      if (entry.isSymbolicLink()) hash.update(JSON.stringify(await readlink(path)))
      else if (entry.isDirectory()) await visit(path, name)
      else
        hash.update(
          createHash('sha256')
            .update(await readFile(path))
            .digest()
        )
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function readReusableInstalledSourceSnapshot({ cache, identity }) {
  let metadata
  try {
    metadata = JSON.parse(await readFile(join(cache, 'snapshot.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    metadata.schemaVersion !== 1 ||
    !isDeepStrictEqual(metadata.identity, identity)
  )
    return null
  try {
    if ((await treeHash(join(cache, 'slot'))) !== metadata.sha256) return null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return metadata
}

export async function canReuseInstalledSourceSnapshot({ cache, identity }) {
  return Boolean(await readReusableInstalledSourceSnapshot({ cache, identity }))
}

export async function saveInstalledSourceSnapshot({ cache, slot, dataDirectory, identity }) {
  if (await canReuseInstalledSourceSnapshot({ cache, identity })) return false
  const parent = dirname(cache)
  await mkdir(parent, { recursive: true })
  // Publish a complete cache entry so an interrupted copy cannot leave a
  // snapshot that a later channel mistakes for reusable.
  const staging = await mkdtemp(join(parent, '.installed-source-snapshot-'))
  try {
    const contents = join(staging, 'slot')
    await copyTree(slot, contents)
    await writeFile(
      join(staging, 'snapshot.json'),
      JSON.stringify({
        schemaVersion: 1,
        identity,
        dataDirectory,
        slot,
        sha256: await treeHash(contents),
      })
    )
    await rm(cache, { recursive: true, force: true })
    await rename(staging, cache)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return true
}

export async function restoreInstalledSourceSnapshot({ cache, slot, dataDirectory, identity }) {
  let metadata
  try {
    await lstat(cache)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  metadata = JSON.parse(await readFile(join(cache, 'snapshot.json'), 'utf8'))
  assert.equal(metadata.schemaVersion, 1)
  assert.deepEqual(metadata.identity, identity, 'Installed-source snapshot identity differs')
  assert.equal(
    await treeHash(join(cache, 'slot')),
    metadata.sha256,
    'Installed-source snapshot changed'
  )
  await copyTree(join(cache, 'slot'), slot)
  const moves = [
    [metadata.slot, slot],
    [metadata.dataDirectory, dataDirectory],
  ]
  const manifestPath = join(slot, 'profile', 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const [name, value] of Object.entries(manifest.dependencies ?? {}))
    if (typeof value === 'string' && value.startsWith('file:'))
      manifest.dependencies[name] = `file:${relocatePath(value.slice(5), moves)}`
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const preparedPath = join(slot, 'prepared.json')
  const prepared = JSON.parse(await readFile(preparedPath, 'utf8'))
  for (const [name, value] of Object.entries(prepared.components))
    if (typeof value === 'string') prepared.components[name] = relocatePath(value, moves)
  await writeFile(preparedPath, JSON.stringify(prepared))
  const releasePath = join(slot, 'release.json')
  const release = JSON.parse(await readFile(releasePath, 'utf8'))
  for (const name of ['runtimeRoot', 'profileRoot'])
    release[name] = relocatePath(release[name], moves)
  await writeFile(releasePath, JSON.stringify(release))
  await relocateLinks(slot, moves)
  return true
}
