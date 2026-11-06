import { constants } from 'node:fs'
import { access, lstat, readlink, readdir, realpath, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from 'node:path'
import { macosInstallationStage } from './macos-installation-paths.js'
import { optionalText, releaseId, type DesktopRelease, type ReleaseStore } from './release-store.js'

interface PreservedOwner {
  slot: string
  owner: string
  snapshot: string
}

export interface ReleaseCleanupPlan {
  markers: string[]
  releases: string[]
  snapshots: string[]
}

/** Resolve every live dependency before deleting any release or recovery metadata. */
export async function planReleaseCleanup(store: ReleaseStore): Promise<ReleaseCleanupPlan> {
  const plan: ReleaseCleanupPlan = { markers: [], releases: [], snapshots: [] }
  const active = await store.active()
  if (!active) return plan
  if (!(await stat(active.profileRoot)).isDirectory())
    throw new Error('The active release profile is not a directory')
  await access(join(active.profileRoot, 'package.json'), constants.R_OK)
  const slots = join(store.root, 'slots')
  const physicalSlots = await realpath(slots)
  const entries = await readdir(slots, { withFileTypes: true })
  const ids = entries.filter(entry => entry.isDirectory()).map(entry => releaseId(entry.name))
  const activation = await store.activation()
  const roots = new Set<string>([active.id])
  for (const id of [
    await optionalText(join(store.root, 'previousHealthy')),
    activation?.from,
    activation?.to,
  ])
    if (id) roots.add(releaseId(id))
  const snapshots = new Set<string>()
  if (activation) snapshots.add(activation.snapshot)
  const last = await optionalText(join(store.root, 'last-activation.json'))
  if (last) snapshots.add(storedReleaseId(JSON.parse(last).snapshot))
  const owners = await preservedReleaseRoots(store, ids, roots, snapshots)
  const bridge = await optionalText(join(store.root, 'bridge'))
  if (bridge) for (const id of await pathOwners(slots, physicalSlots, bridge)) roots.add(id)
  const retained = await retainedReleases(store, roots, owners, snapshots, physicalSlots)
  for (const marker of owners)
    if (!retained.has(marker.owner))
      plan.markers.push(join(store.slot(marker.slot), 'preserved-data-snapshot'))
  const obsolete = ids.filter(id => !retained.has(id))
  plan.releases = await releaseRemovalPaths(store, active, obsolete)
  plan.snapshots = (await directoryNames(join(store.root, 'snapshots')))
    .filter(id => !snapshots.has(id))
    .map(id => join(store.root, 'snapshots', id))
  return plan
}

async function preservedReleaseRoots(
  store: ReleaseStore,
  ids: string[],
  roots: Set<string>,
  snapshots: Set<string>
): Promise<PreservedOwner[]> {
  const owners: PreservedOwner[] = []
  for (const slot of ids) {
    const marker = await optionalText(join(store.slot(slot), 'preserved-data-snapshot'))
    if (!marker) continue
    if (marker.startsWith('{')) {
      const value = JSON.parse(marker)
      if (value.kind !== 'macos-source-owner') throw new Error('Unknown preserved release owner')
      owners.push({
        slot,
        owner: storedReleaseId(value.owner),
        snapshot: storedReleaseId(value.snapshot),
      })
    } else {
      roots.add(slot)
      snapshots.add(releaseId(marker))
    }
  }
  for (const snapshot of await directoryNames(join(store.root, 'preserved-data'))) {
    const id = await optionalText(join(store.root, 'preserved-data', snapshot, 'retained-release'))
    if (id) {
      roots.add(releaseId(id))
      snapshots.add(releaseId(snapshot))
    }
  }
  return owners
}

function storedReleaseId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid release cleanup reference')
  return releaseId(value)
}

async function retainedReleases(
  store: ReleaseStore,
  roots: Set<string>,
  owners: PreservedOwner[],
  snapshots: Set<string>,
  physicalSlots: string
): Promise<Set<string>> {
  const retained = new Set<string>()
  // Set iteration includes new dependencies and terminates even for shared or cyclic owners.
  for (const id of roots) {
    if (retained.has(id)) continue
    const release = await store.read(id)
    retained.add(id)
    if (release.retainedRelease) roots.add(release.retainedRelease)
    for (const path of releasePaths(release))
      for (const owner of await pathOwners(join(store.root, 'slots'), physicalSlots, path))
        roots.add(owner)
    for (const owner of owners) {
      if (retained.has(owner.owner)) {
        roots.add(owner.slot)
        snapshots.add(owner.snapshot)
      }
    }
  }
  return retained
}

function releasePaths(release: DesktopRelease): string[] {
  return [
    release.executable,
    release.resources,
    release.runtimeRoot,
    release.profileRoot,
    release.componentDataDirectory,
    release.macosInstallation?.payloadExecutable,
  ].filter((path): path is string => path !== undefined)
}

function slotOwner(slots: string, path: string): string | null {
  const offset = relative(toNamespacedPath(slots), toNamespacedPath(path))
  if (!offset || isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) return null
  return releaseId(offset.split(sep)[0])
}

/** Keep the containing slot and every link target, including intermediate junctions. */
async function pathOwners(
  slots: string,
  physicalSlots: string,
  path: string
): Promise<Set<string>> {
  const owners = new Set<string>()
  const visited = new Set<string>()
  let current = resolve(path)
  while (!visited.has(current)) {
    visited.add(current)
    for (const root of [slots, physicalSlots]) {
      const owner = slotOwner(root, current)
      if (owner) owners.add(owner)
    }
    const physical = await physicalPath(current)
    const physicalOwner = slotOwner(physicalSlots, physical)
    if (physicalOwner) owners.add(physicalOwner)
    const target = await linkedAncestor(current)
    if (!target) return owners
    current = target
  }
  throw new Error('Release cleanup encountered a cyclic resource link')
}

async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (dirname(path) === path) return path
    // A not-yet-materialized descendant can still have an unambiguous owner.
    // An existing broken link is different: its target must be repaired before cleanup.
    const metadata = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    })
    if (metadata?.isSymbolicLink())
      throw new Error('Release cleanup encountered a broken link', { cause: error })
    return join(await physicalPath(dirname(path)), basename(path))
  }
}

async function linkedAncestor(path: string): Promise<string | null> {
  let ancestor = path
  while (dirname(ancestor) !== ancestor) {
    const metadata = await lstat(ancestor).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    })
    if (metadata?.isSymbolicLink())
      return resolve(dirname(ancestor), await readlink(ancestor), relative(ancestor, path))
    ancestor = dirname(ancestor)
  }
  return null
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.some(entry => entry.isSymbolicLink()))
      throw new Error('Release recovery metadata contains a linked directory')
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function releaseRemovalPaths(
  store: ReleaseStore,
  active: DesktopRelease,
  obsolete: string[]
): Promise<string[]> {
  const paths: string[] = []
  const installation = await optionalText(join(store.root, 'macos-application'))
  const physicalRoot = installation ? await realpath(store.root) : null
  for (const id of obsolete) {
    if (installation) {
      const executable = join(
        installation,
        'Contents',
        'MacOS',
        active.executable.split(/[\\/]/).at(-1)!
      )
      const stage = dirname(macosInstallationStage(executable, id))
      const value = await optionalText(join(stage, 'release-owner.json'))
      if (value) {
        const owner = JSON.parse(value)
        if (owner.schemaVersion !== 1 || owner.storeRoot !== physicalRoot || owner.releaseId !== id)
          throw new Error('The macOS release cleanup owner does not match')
        paths.push(stage)
      }
    }
    paths.push(store.slot(id))
  }
  return paths
}
