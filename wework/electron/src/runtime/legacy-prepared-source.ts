import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { hashComponentPath } from './component-content-hash.js'
import { currentCoreProfile, profileRevision } from './release-profile.js'
import { type DesktopRelease, type ReleaseStore } from './release-store.js'

/** Old updaters prepare a copied host/profile before asking B to prepare. */
export async function ownsLegacyPreparedSource(
  store: ReleaseStore,
  source: DesktopRelease,
  sourceProfile: string,
  parent: string
): Promise<boolean> {
  if (!source.id.startsWith(`installed-${source.version}-`)) return false
  const root = await realpath(store.root)
  const slots = await realpath(join(store.root, 'slots'))
  if (slots !== join(root, 'slots')) return false
  const slot = await realpath(store.slot(source.id))
  if (slot !== join(slots, source.id)) return false
  if (resolve(source.profileRoot) !== join(store.slot(source.id), 'profile')) return false
  if ((await realpath(source.profileRoot)) !== join(slot, 'profile')) return false
  if ((await realpath(sourceProfile)) !== (await realpath(currentCoreProfile(dirname(store.root)))))
    return false
  const host = await realpath(join(slot, 'host'))
  if (host !== join(slot, 'host')) return false
  for (const path of [source.executable, source.resources]) {
    const child = relative(host, await realpath(path))
    if (
      !child ||
      child === '..' ||
      child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(child)
    )
      return false
  }
  const prepared = JSON.parse(await readFile(join(slot, 'prepared.json'), 'utf8'))
  if (prepared.sourceRevision !== (await profileRevision(sourceProfile))) return false
  const parentResources =
    process.platform === 'darwin'
      ? resolve(dirname(parent), '../Resources')
      : join(dirname(parent), 'resources')
  for (const [copy, original] of [
    [source.executable, parent],
    [join(source.resources, 'app.asar'), join(parentResources, 'app.asar')],
  ])
    if ((await hashComponentPath(copy)) !== (await hashComponentPath(original))) return false
  return true
}
