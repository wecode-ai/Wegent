import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { upgradeUserEnvironment } from './upgrade-user-environment.mjs'

const execute = promisify(execFile)

/** Run the shipped cleaner with the application stopped, using only its isolated test store. */
export async function verifyCrossSlotProfile(root, resultDir, homePath) {
  const id = (await readFile(join(root, 'active'), 'utf8')).trim()
  const release = JSON.parse(await readFile(join(root, 'slots', id, 'release.json'), 'utf8'))
  const executable = release.macosInstallation?.payloadExecutable ?? release.executable
  const resources =
    process.platform === 'darwin'
      ? resolve(dirname(executable), '../Resources')
      : join(dirname(executable), 'resources')
  const module = pathToFileURL(join(resources, 'app.asar/dist/runtime/release-store.js')).href
  const script = [
    `import { ReleaseStore } from ${JSON.stringify(module)}`,
    `import { rehomeAndPruneProfile } from ${JSON.stringify(import.meta.url)}`,
    `await rehomeAndPruneProfile(new ReleaseStore(${JSON.stringify(root)}), ${JSON.stringify(resultDir)})`,
  ].join('\n')
  await execute(executable, ['--input-type=module', '-e', script], {
    env: { ...upgradeUserEnvironment(process.env, homePath), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  })
}

/** Reproduce a retained installation borrowing another slot's actual profile directory. */
export async function rehomeAndPruneProfile(store, resultDir) {
  const active = await store.active()
  assert.ok(active, 'The real rollback must select a source before the cleanup regression')
  const original = await realpath(active.profileRoot)
  const metadata = await stat(original, { bigint: true })
  const ownerId = `profile-owner-${randomUUID()}`
  const ownerRoot = store.slot(ownerId)
  const profileRoot = join(ownerRoot, 'profile')
  await mkdir(ownerRoot, { recursive: true })
  await rename(original, profileRoot)
  // Keep existing absolute file dependencies and package links resolving through
  // their original location while the descriptor names the actual new owner.
  await symlink(profileRoot, original, process.platform === 'win32' ? 'junction' : 'dir')
  const owner = { ...active, id: ownerId, profileRoot }
  delete owner.macosInstallation
  delete owner.retainedRelease
  await store.save(owner)
  await store.save({ ...active, profileRoot })
  const unusedId = `unreferenced-${randomUUID()}`
  await store.save({ ...owner, id: unusedId })
  assert.deepEqual(
    await store.prune(),
    { status: 'completed' },
    'The source package must include ownership-aware cleanup; rebuild it from the fix'
  )
  await stat(join(ownerRoot, 'release.json'))
  await stat(join(profileRoot, 'package.json'))
  const retained = await stat(profileRoot, { bigint: true })
  assert.equal(retained.dev, metadata.dev)
  assert.equal(retained.ino, metadata.ino, 'Cleanup replaced the live profile')
  await assert.rejects(stat(store.slot(unusedId)), { code: 'ENOENT' })
  await writeFile(
    join(resultDir, 'cross-slot-profile-result.json'),
    JSON.stringify({ active: active.id, owner: ownerId, retained: true, unusedRemoved: true })
  )
}
