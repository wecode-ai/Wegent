import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { optionalText } from './release-store.js'
import { copyPhysicalRelease, removePhysicalRelease } from './physical-release-files.js'

const PROFILE_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  '.wework-core-plugins.json',
]

export function currentCoreProfile(dataDirectory: string): string {
  return join(dataDirectory, 'dsh-core', 'profiles', 'wework-core')
}

export async function profileRevision(profile: string): Promise<string> {
  const hash = createHash('sha256')
  for (const name of PROFILE_FILES)
    hash
      .update(name)
      .update('\0')
      .update((await optionalText(join(profile, name))) ?? '')
      .update('\0')
  return hash.digest('hex')
}

export async function cloneReleaseProfile(source: string, target: string): Promise<string> {
  const before = await profileRevision(source)
  await removePhysicalRelease(target)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyPhysicalRelease(await realpath(source), target)
  if (before !== (await profileRevision(source)))
    throw new Error('Plugins changed while preparing the update; prepare again')
  return before
}

/** Preserve the running profile only after its writers have stopped. */
export async function retainReleaseProfile(dataDirectory: string, target: string): Promise<void> {
  const pointer = currentCoreProfile(dataDirectory)
  const source = await realpath(pointer)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await rename(source, target)
  await selectReleaseProfile(dataDirectory, target, join(dirname(target), 'legacy-profile'))
}

/** Called by the stable entry before either version opens its profile. */
export async function selectReleaseProfile(
  dataDirectory: string,
  target: string,
  baseline: string
): Promise<void> {
  const pointer = currentCoreProfile(dataDirectory)
  if (resolve(pointer) === resolve(target)) return
  await readFile(join(target, 'package.json'))
  let metadata
  try {
    metadata = await lstat(pointer)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (
    metadata?.isSymbolicLink() &&
    resolve(dirname(pointer), await readlink(pointer)) === resolve(target)
  )
    return
  const temporary = `${pointer}.${randomUUID()}.tmp`
  await mkdir(dirname(pointer), { recursive: true, mode: 0o700 })
  await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    if (metadata && !metadata.isSymbolicLink()) {
      await mkdir(dirname(baseline), { recursive: true, mode: 0o700 })
      await rename(pointer, baseline)
    } else if (process.platform === 'win32' && metadata?.isSymbolicLink()) {
      // Windows cannot replace an existing junction using rename. The release journal
      // remains authoritative, so a crash in this gap recreates the selected junction.
      await unlink(pointer)
    }
    await rename(temporary, pointer)
  } finally {
    await rm(temporary, { force: true })
  }
}
