import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { macosApplication, macosInstallationStage } from './macos-installation-paths.js'
import { copyPhysicalRelease, removePhysicalRelease } from './physical-release-files.js'
import {
  atomicReleaseWrite,
  optionalText,
  type DesktopRelease,
  type ReleaseStore,
} from './release-store.js'
import { verifyReleaseSignature } from './release-signature.js'
import { linkImmutableDirectory } from './immutable-directory.js'

const execute = promisify(execFile)
let selectedResources: string | undefined

export function installedMacosReleaseResources(): string | undefined {
  return selectedResources
}

function contains(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child)
}

async function bundleIdentifier(application: string): Promise<string> {
  const { stdout } = await execute('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    join(application, 'Contents', 'Info.plist'),
  ])
  return stdout.trim()
}

async function bridgedApplication(
  store: ReleaseStore,
  source: DesktopRelease,
  root: string
): Promise<string | null> {
  // Legacy registration copied the host into a slot, but retained the exact
  // installed executable as its bridge. Verify this owned handoff before
  // consulting unrelated Launch Services registrations.
  const bridge = await optionalText(join(store.root, 'bridge'))
  if (!bridge) return null
  const candidate = await realpath(macosApplication(bridge))
  if (contains(root, candidate)) return null
  await execute('/usr/bin/cmp', [
    '-s',
    source.executable,
    join(candidate, 'Contents', 'MacOS', basename(source.executable)),
  ])
  await execute('/usr/bin/cmp', [
    '-s',
    join(source.resources, 'app.asar'),
    join(candidate, 'Contents', 'Resources', 'app.asar'),
  ])
  return candidate
}

async function installedApplication(
  store: ReleaseStore,
  source: DesktopRelease,
  release: DesktopRelease,
  identifier: string
): Promise<string> {
  const root = await realpath(store.root)
  const sourceBundle = await realpath(macosApplication(source.executable))
  const saved = await optionalText(join(store.root, 'macos-application'))
  let application = !contains(root, sourceBundle) ? sourceBundle : saved
  if (!application) application = await bridgedApplication(store, source, root)
  if (!application) {
    // Delivered upgrades retained the original installation in previousHealthy.
    // Prefer that transaction-owned URL over unrelated Launch Services copies.
    const previousId = await optionalText(join(store.root, 'previousHealthy'))
    if (previousId) {
      const previous = await store.read(previousId)
      const previousBundle = await realpath(macosApplication(previous.executable))
      if (!contains(root, previousBundle)) application = previousBundle
    }
  }
  if (!application) {
    // Already-delivered clients only recorded their versioned host. Ask Launch
    // Services for this product's installation; never guess an Applications path.
    const { stdout } = await execute(join(release.resources, 'wework-launcher'), [
      '--macos-applications',
      identifier,
    ])
    const candidates = new Set<string>()
    for (const path of stdout.split('\n').filter(Boolean)) {
      let candidate: string
      try {
        candidate = await realpath(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!contains(root, candidate)) candidates.add(candidate)
    }
    if (candidates.size !== 1)
      throw new Error('The installed macOS application cannot be identified uniquely')
    application = [...candidates][0]
  }
  application = await realpath(application)
  if (contains(root, application) || (await bundleIdentifier(application)) !== identifier)
    throw new Error('The macOS installation does not match the update source')
  await verifyReleaseSignature(
    source.executable,
    join(application, 'Contents', 'MacOS', basename(source.executable))
  )
  return application
}

async function retainLegacySource(
  store: ReleaseStore,
  source: DesktopRelease,
  application: string,
  releaseId: string
): Promise<DesktopRelease> {
  const id = `macos-source-${createHash('sha256').update(releaseId).digest('hex').slice(0, 40)}`
  const retained = join(store.slot(id), 'host', basename(application))
  const executable = await retainProgram(source.executable, retained)
  const sourceComponents = join(
    source.componentDataDirectory ?? store.slot(source.id),
    'managed-components'
  )
  const retainedComponents = join(store.slot(id), 'managed-components')
  if (existsSync(sourceComponents))
    await linkImmutableDirectory(
      retainedComponents,
      sourceComponents,
      async path =>
        existsSync(path) && (await realpath(path)) === (await realpath(sourceComponents))
    )
  const installedExecutable = join(application, 'Contents', 'MacOS', basename(source.executable))
  const retainedSource: DesktopRelease = {
    ...source,
    id,
    executable: installedExecutable,
    resources: join(application, 'Contents', 'Resources'),
    componentDataDirectory: store.slot(id),
    retainedRelease: source.id,
    macosInstallation: { payloadExecutable: executable, bootstrapFromPayload: false },
  }
  const prepared = JSON.parse(await readFile(join(store.slot(source.id), 'prepared.json'), 'utf8'))
  prepared.components = relocateComponents(
    prepared.components,
    source.resources,
    join(application, 'Contents', 'Resources')
  )
  prepared.components = relocateComponents(
    prepared.components,
    sourceComponents,
    retainedComponents
  )
  await store.save(retainedSource)
  await atomicReleaseWrite(join(store.slot(id), 'prepared.json'), JSON.stringify(prepared))
  return retainedSource
}

async function retainProgram(source: string, application: string): Promise<string> {
  if (!existsSync(application)) await copyPhysicalRelease(macosApplication(source), application)
  const executable = join(application, 'Contents', 'MacOS', basename(source))
  await verifyReleaseSignature(source, executable)
  await execute('/usr/bin/cmp', ['-s', source, executable])
  return executable
}

async function retainPreviousInstallation(
  store: ReleaseStore,
  activeId: string,
  application: string
): Promise<void> {
  const previousId = await optionalText(join(store.root, 'previousHealthy'))
  if (!previousId || previousId === activeId) return
  const previous = await store.read(previousId)
  if (
    previous.macosInstallation ||
    (await realpath(macosApplication(previous.executable))) !== application
  )
    return
  const retained = join(store.slot(previous.id), 'macos-installed-host', basename(application))
  const executable = await retainProgram(previous.executable, retained)
  const resources = join(retained, 'Contents', 'Resources')
  const preparedPath = join(store.slot(previous.id), 'prepared.json')
  const prepared = JSON.parse(await readFile(preparedPath, 'utf8'))
  prepared.components = relocateComponents(prepared.components, previous.resources, resources)
  await atomicReleaseWrite(preparedPath, JSON.stringify(prepared))
  await store.save({ ...previous, executable, resources })
}

async function stageApplication(store: ReleaseStore, release: DesktopRelease): Promise<void> {
  const payload = release.macosInstallation!.payloadExecutable
  const stage = macosInstallationStage(release.executable, release.id)
  const directory = dirname(stage)
  const storeRoot = await realpath(store.root)
  if (existsSync(directory)) {
    const value = await optionalText(join(directory, 'release-owner.json'))
    const owner = value ? JSON.parse(value) : null
    if (
      !(await lstat(directory)).isDirectory() ||
      owner?.schemaVersion !== 1 ||
      owner.storeRoot !== storeRoot ||
      owner.releaseId !== release.id
    )
      throw new Error('The macOS installation stage belongs to another owner')
    await removePhysicalRelease(directory)
  }
  await mkdir(directory, { mode: 0o700 })
  await atomicReleaseWrite(
    join(directory, 'release-owner.json'),
    JSON.stringify({
      schemaVersion: 1,
      storeRoot,
      releaseId: release.id,
    })
  )
  try {
    await copyPhysicalRelease(macosApplication(payload), stage)
    const executable = join(stage, 'Contents', 'MacOS', basename(payload))
    await verifyReleaseSignature(payload, executable)
    await execute('/usr/bin/cmp', ['-s', payload, executable])
  } catch (error) {
    await removePhysicalRelease(directory)
    throw error
  }
}

async function pruneAbandonedStages(store: ReleaseStore, executable: string): Promise<void> {
  const application = macosApplication(executable)
  const parent = dirname(application)
  const prefix = `.${basename(application)}.wework-`
  const root = await realpath(store.root)
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const directory = join(parent, entry.name)
    const value = await optionalText(join(directory, 'release-owner.json'))
    if (!value) continue
    let owner
    try {
      owner = JSON.parse(value)
    } catch {
      continue
    }
    if (
      owner.schemaVersion !== 1 ||
      owner.storeRoot !== root ||
      typeof owner.releaseId !== 'string' ||
      entry.name !== `${prefix}${owner.releaseId}`
    )
      continue
    if (!(await optionalText(join(store.slot(owner.releaseId), 'release.json'))))
      await removePhysicalRelease(directory)
  }
}

function relocateComponents(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string')
    return isAbsolute(value) && contains(from, value) ? join(to, relative(from, value)) : value
  if (Array.isArray(value)) return value.map(item => relocateComponents(item, from, to))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relocateComponents(item, from, to)])
    )
  return value
}

/** Stage signed program files only; the source keeps its live data and windows. */
export async function prepareMacosReleaseInstallation(
  store: ReleaseStore,
  release: DesktopRelease,
  identifier: string
): Promise<void> {
  if (process.platform !== 'darwin') return
  if (typeof identifier !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(identifier))
    throw new Error('The macOS package has an invalid application identifier')
  const source = await store.active()
  if (!source) return
  if (basename(source.executable) !== basename(release.executable))
    throw new Error('The macOS update cannot change the installed executable name')
  const application = await installedApplication(store, source, release, identifier)
  const executable = join(application, 'Contents', 'MacOS', basename(release.executable))
  await atomicReleaseWrite(join(store.root, 'macos-application'), application)
  await pruneAbandonedStages(store, executable)
  await retainPreviousInstallation(store, source.id, application)
  const installedSource = source.macosInstallation
    ? source
    : await retainLegacySource(store, source, application, release.id)
  const installedTarget: DesktopRelease = {
    ...release,
    executable,
    macosInstallation: {
      payloadExecutable: release.executable,
      bootstrapFromPayload: true,
      ...(installedSource.id === source.id
        ? {}
        : {
            sourceReleaseId: source.id,
            rollbackReleaseId: installedSource.id,
          }),
    },
  }
  await stageApplication(store, installedSource)
  await stageApplication(store, installedTarget)
  await store.save(installedTarget)
}

/** Keep the legacy supervisor's child alive while a fresh PID enters AppKit. */
export async function enterInstalledMacosRelease(
  store: ReleaseStore,
  release: DesktopRelease,
  resources: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const installation = release.macosInstallation
  if (process.platform !== 'darwin' || !installation) return
  if (resolve(process.execPath) === resolve(release.executable)) {
    selectedResources = release.resources
    return
  }
  // Only the selected payload can perform this one-use handoff, before opening data.
  if (resolve(process.execPath) !== resolve(installation.payloadExecutable))
    throw new Error('The macOS bootstrap is not the selected release payload')
  const launcher = join(resources, 'wework-launcher')
  // Re-execing Electron at the same PID leaves RunningBoard's cached PID version
  // stale. Control Center then rejects every NSStatusItem scene for the host.
  // The native relay preserves supervision but spawns Electron with a new PID.
  process.execve!(
    launcher,
    [launcher, '--macos-enter', store.root, release.id, ...process.argv.slice(1)],
    {
      ...environment,
      WEWORK_RELEASE_SUPERVISED: release.id,
    } as NodeJS.ProcessEnv & Record<string, string>
  )
  throw new Error('The installed macOS host handoff returned unexpectedly')
}
