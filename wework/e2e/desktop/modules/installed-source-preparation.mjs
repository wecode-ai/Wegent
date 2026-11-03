import assert from 'node:assert/strict'
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, toNamespacedPath } from 'node:path'

function relocated(path, source, target) {
  const suffix = relative(toNamespacedPath(source), toNamespacedPath(path))
  if (
    isAbsolute(suffix) ||
    suffix === '..' ||
    suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
    return path
  return join(target, suffix)
}

async function relocateLinks(directory, source, target) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const original = await readlink(path)
      const destination = resolve(dirname(path), original)
      const replacement = relocated(destination, source, target)
      if (replacement !== destination) {
        await rm(path)
        await symlink(replacement, path, process.platform === 'win32' ? 'junction' : 'dir')
      }
    } else if (entry.isDirectory()) await relocateLinks(path, source, target)
  }
}

/** Install the source CLI's prepared state in the normal thin-installation layout. */
export async function installPreparedSource(slot, dataDirectory) {
  const preparedProfile = join(slot, 'profile')
  const profile = join(dataDirectory, 'dsh-core', 'profiles', 'wework-core')
  const manifest = JSON.parse(await readFile(join(preparedProfile, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies && typeof manifest.dependencies === 'object')
  // Move ownership rather than copying thousands of files a second time. Internal
  // publication junctions and file dependencies must follow their moved content.
  const sourceComponents = join(slot, 'managed-components')
  const components = join(dataDirectory, 'managed-components')
  await rename(sourceComponents, components)
  await relocateLinks(components, sourceComponents, components)
  for (const [name, dependency] of Object.entries(manifest.dependencies)) {
    if (typeof dependency === 'string' && dependency.startsWith('file:'))
      manifest.dependencies[name] =
        `file:${relocated(dependency.slice(5), sourceComponents, components)}`
  }
  await writeFile(join(preparedProfile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await relocateLinks(preparedProfile, sourceComponents, components)
  await mkdir(dirname(profile), { recursive: true })
  await rm(profile, { recursive: true, force: true })
  await rename(preparedProfile, profile)
  // The caller keeps source-preparation for retained-version fault fixtures.
  // No active/bridge marker is written: the real updater still registers this
  // installed source and exercises the thin-installation ownership assertions.
}
