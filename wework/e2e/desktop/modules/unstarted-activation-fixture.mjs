import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, symlink, writeFile, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { upgradeUserEnvironment } from './upgrade-user-environment.mjs'

/** Legacy hosts derive component ownership from the selected slot itself. */
export async function retainUnstartedSourceComponents(dataDirectory, slot, components) {
  const installed = join(dataDirectory, 'managed-components')
  const retained = join(slot, 'managed-components')
  const paths = Object.entries(components).map(([name, path]) => {
    const child = relative(installed, path)
    const owned =
      child !== '..' &&
      !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(child)
    return [name, owned ? join(retained, child) : path, owned]
  })
  if (paths.some(([, , owned]) => owned)) {
    await mkdir(slot, { recursive: true })
    await symlink(installed, retained, process.platform === 'win32' ? 'junction' : 'dir')
  }
  return Object.fromEntries(paths.map(([name, path]) => [name, path]))
}

/** Called only after the shared restart helper has stopped every source writer. */
export async function seedUnstartedActivation({
  dataDirectory,
  executorHome,
  root,
  resultDir,
  running,
  from,
  homePath,
}) {
  // A retained installation owns the pending transaction's preparation API.
  // The running legacy package may predate retainReleaseProfile entirely.
  const preparationExecutable = from.installedSource?.executable ?? running.hostExecutable
  const resources =
    process.platform === 'darwin'
      ? resolve(dirname(running.hostExecutable), '../Resources')
      : join(dirname(running.hostExecutable), 'resources')
  const preparationResources =
    process.platform === 'darwin'
      ? resolve(dirname(preparationExecutable), '../Resources')
      : join(dirname(preparationExecutable), 'resources')
  const module = name =>
    JSON.stringify(pathToFileURL(join(preparationResources, 'app.asar/dist/runtime', name)).href)
  const source = {
    schemaVersion: 1,
    id: 'installed-unstarted-source',
    version: from.version,
    executable: running.hostExecutable,
    resources,
    runtimeRoot: running.runtimeRoot,
    componentDataDirectory: join(root, 'slots/installed-unstarted-source'),
    profileRoot: join(root, 'slots/installed-unstarted-source/retained-profile'),
    dataSchema: from.dataSchema,
    readableDataSchemas: from.readableDataSchemas,
  }
  const components = await retainUnstartedSourceComponents(
    dataDirectory,
    source.componentDataDirectory,
    {
      coreDsh: running.coreDshPath,
      weworkCorePlugins: running.corePluginsPath,
      executor: running.executorPath,
      codex: running.codexPath,
      dws: running.dwsPath,
    }
  )
  const script = join(resultDir, 'seed-unstarted-activation.mjs')
  await writeFile(
    script,
    `
import { join } from 'node:path'
import { ReleaseStore, atomicReleaseWrite } from ${module('release-store.js')}
import { snapshotReleaseData } from ${module('release-snapshot.js')}
import { retainReleaseProfile } from ${module('release-profile.js')}
const store = new ReleaseStore(${JSON.stringify(root)})
const source = ${JSON.stringify(source)}
const target = await store.read('source-preparation')
await store.save(source)
await atomicReleaseWrite(join(store.root, 'active'), source.id)
await atomicReleaseWrite(join(store.slot(source.id), 'prepared.json'), JSON.stringify({ components: ${JSON.stringify(components)} }))
const snapshot = await snapshotReleaseData(${JSON.stringify(dataDirectory)}, store.root, ${JSON.stringify(executorHome)})
await retainReleaseProfile(${JSON.stringify(dataDirectory)}, source.profileRoot)
await store.activate(target, snapshot)
`
  )
  await promisify(execFile)(preparationExecutable, [script], {
    env: { ...upgradeUserEnvironment(process.env, homePath), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  const activation = JSON.parse(await readFile(join(root, 'activation.json'), 'utf8'))
  assert.equal(activation.from, source.id)
  assert.equal(activation.to, 'source-preparation')
  assert.equal((await readFile(join(root, 'trial'), 'utf8')).trim(), activation.token)
  return activation
}
