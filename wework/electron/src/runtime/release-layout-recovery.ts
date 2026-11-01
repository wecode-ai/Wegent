import { lstat, readFile, realpath, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ReleaseStore } from './release-store.js'
import { resolveWorkbenchPaths } from './workbench-environment.js'
import { releaseParentExecutable } from './release-parent-process.js'

// These delivered clients read <desktop>/releases before main migrates userData.
// Target-owned preparation can repair that handoff without modifying signed hosts.
const AFFECTED_VERSIONS = new Set(['0.6.2', '0.6.3', '0.6.4-beta.1'])

export async function recoverReleaseLayout(
  store: ReleaseStore,
  sourceProfile: string,
  nextDataSchema: number,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (environment.WEWORK_USER_DATA_DIR?.trim()) return
  const activation = await store.activation()
  const source = activation ? await store.read(activation.from) : await store.active()
  if (!source || !AFFECTED_VERSIONS.has(source.version)) return
  if (!source.readableDataSchemas.includes(nextDataSchema))
    throw new Error('Repair the legacy release layout before upgrading the data schema')
  const metadata = JSON.parse(
    await readFile(join(source.resources, 'app.asar', 'package.json'), 'utf8')
  )
  if (metadata.version !== source.version) throw new Error('Recovery source identity changed')
  const desktop = resolveWorkbenchPaths({
    environment,
    metadata,
    homeDirectory: environment.HOME || environment.USERPROFILE || '',
  }).desktop
  if (resolve(store.root) !== join(desktop, 'user-data', 'releases')) return
  if ((await realpath(source.profileRoot)) !== (await realpath(sourceProfile)))
    throw new Error('Recovery source profile does not own the running application data')
  if ((await releaseParentExecutable()) !== (await realpath(source.executable)))
    throw new Error('Recovery source does not match the running update host')
  const prepare = async () => {
    await publishDirectoryBridge(join(desktop, 'releases'), store.root)
    await publishDirectoryBridge(join(desktop, 'dsh-core'), join(desktop, 'user-data', 'dsh-core'))
  }
  // The target has never opened data. Restore only release selection; keep the
  // live source profile, snapshots, credentials and repositories in place.
  if (activation) await store.recoverUnstartedActivation(source.id, prepare)
  else await prepare()
}

async function publishDirectoryBridge(legacy: string, target: string): Promise<void> {
  let entry
  try {
    entry = await lstat(legacy)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (entry) {
    if (!entry.isSymbolicLink() || (await realpath(legacy)) !== (await realpath(target)))
      throw new Error('Legacy release directory conflicts with the application release store')
  } else {
    await symlink(target, legacy, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
