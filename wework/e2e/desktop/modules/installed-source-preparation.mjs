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
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path'

export const SOURCE_DISABLED_PLUGIN = '@wegent/dsh-connection-dingtalk'

export function installedSourcePlugins() {
  return { version: 1, order: [], disabled: [SOURCE_DISABLED_PLUGIN] }
}

export function installedSourceSnapshotIdentity(source) {
  return { sha256: source.sha256, plugins: installedSourcePlugins() }
}

export function installedSourcePreparationRequest(source, dataDirectory) {
  return {
    storeRoot: join(dataDirectory, 'releases'),
    sourceProfile: join(dataDirectory, 'dsh-core/profiles/wework-core'),
    release: {
      schemaVersion: 1,
      id: 'source-preparation',
      version: source.version,
      executable: source.executable,
      resources: source.resources,
      runtimeRoot: join(dataDirectory, 'managed-runtimes/dsh'),
      profileRoot: join(dataDirectory, 'releases/slots/source-preparation/profile'),
      dataSchema: source.dataSchema,
      readableDataSchemas: source.readableDataSchemas,
    },
  }
}

function relocated(path, source, target) {
  const suffix = relative(toNamespacedPath(source), toNamespacedPath(path))
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return path
  return join(target, suffix)
}

export function relocatePath(path, moves) {
  for (const [source, target] of moves) {
    const replacement = relocated(path, source, target)
    if (replacement !== path) return replacement
  }
  return path
}

export async function relocateLinks(directory, moves) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const original = await readlink(path)
      const originalLocation = relocatePath(
        path,
        moves.map(([from, to]) => [to, from])
      )
      const destination = resolve(dirname(originalLocation), original)
      const replacement = relocatePath(destination, moves)
      if (replacement !== resolve(dirname(path), original)) {
        await rm(path)
        await symlink(replacement, path, process.platform === 'win32' ? 'junction' : 'dir')
      }
    } else if (entry.isDirectory()) await relocateLinks(path, moves)
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
  const moves = [
    [sourceComponents, components],
    [preparedProfile, profile],
  ]
  await rename(sourceComponents, components)
  for (const [name, dependency] of Object.entries(manifest.dependencies)) {
    if (typeof dependency === 'string' && dependency.startsWith('file:'))
      manifest.dependencies[name] = `file:${relocatePath(dependency.slice(5), moves)}`
  }
  await writeFile(join(preparedProfile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await mkdir(dirname(profile), { recursive: true })
  await rm(profile, { recursive: true, force: true })
  await rename(preparedProfile, profile)
  await relocateLinks(components, moves)
  await relocateLinks(profile, moves)
  // The caller keeps source-preparation for retained-version fault fixtures.
  // No active/bridge marker is written: the real updater still registers this
  // installed source and exercises the thin-installation ownership assertions.
}
