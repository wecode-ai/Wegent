import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  atomicReleaseWrite,
  optionalText,
  type DesktopRelease,
  type ReleaseStore,
} from './release-store.js'
import { terminateProcessTree } from './runtime-supervisor.js'

const execute = promisify(execFile)
const RECEIPT = 'after-stop-ready.json'

export interface AfterStopMetadata {
  weworkAfterStopPreparation?: unknown
}

export interface AfterStopHomes {
  codexHome: string
  workbenchRoot: string
}

function requiresPreparation(metadata: AfterStopMetadata): boolean {
  if (metadata.weworkAfterStopPreparation === undefined) return false
  if (metadata.weworkAfterStopPreparation !== 1)
    throw new Error('Unsupported stopped-release preparation protocol')
  return true
}

function requireImmutablePackage(release: DesktopRelease): void {
  if (!release.packageSha256 || !/^[a-f0-9]{64}$/.test(release.packageSha256))
    throw new Error('Stopped-release preparation requires an immutable package identity')
}

export async function assertReleaseAfterStopReady(
  store: ReleaseStore,
  release: DesktopRelease,
  metadata: AfterStopMetadata
): Promise<void> {
  if (!requiresPreparation(metadata)) return
  requireImmutablePackage(release)
  const activation = await store.activation()
  if (!activation || activation.to !== release.id) return
  let receipt
  try {
    receipt = JSON.parse((await optionalText(join(store.root, RECEIPT))) ?? 'null')
  } catch {
    throw new Error('Invalid stopped-release preparation receipt')
  }
  if (
    receipt?.protocol !== 1 ||
    receipt.token !== activation.token ||
    receipt.releaseId !== release.id ||
    receipt.packageSha256 !== release.packageSha256
  )
    throw new Error('This release requires a bridge updater to prepare stopped session data')
}

/** Called by the healthy bridge before starting the trial's timed supervisor. */
export async function prepareReleaseAfterStop(
  store: ReleaseStore,
  release: DesktopRelease,
  dataDirectory: string,
  homes: AfterStopHomes
): Promise<void> {
  const activation = await store.activation()
  if (
    !activation ||
    activation.to !== release.id ||
    activation.rollbackRequested ||
    (await optionalText(join(store.root, 'attempted'))) === activation.token
  )
    return
  const metadata: AfterStopMetadata = JSON.parse(
    await readFile(join(release.resources, 'app.asar', 'package.json'), 'utf8')
  )
  if (!requiresPreparation(metadata)) return
  requireImmutablePackage(release)
  const request = join(store.slot(release.id), 'after-stop-request.json')
  await atomicReleaseWrite(
    request,
    JSON.stringify({
      protocol: 1,
      release,
      token: activation.token,
      storeRoot: store.root,
      dataDirectory,
      ...homes,
    })
  )
  // An incompatible hook has opened mutable data. Existing rollback consent and
  // snapshot recovery must cover it, including interruption before the trial.
  await atomicReleaseWrite(join(store.root, 'data-opened'), activation.token)
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  const executionOptions: ExecFileOptionsWithStringEncoding & { detached: boolean } = {
    env: environment,
    detached: process.platform !== 'win32',
    timeout: 0,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    windowsHide: true,
  }
  const execution = execute(
    release.macosInstallation?.payloadExecutable ?? release.executable,
    [join(release.resources, 'app.asar', 'dist', 'runtime', 'release-after-stop-cli.js'), request],
    executionOptions
  )
  try {
    const { stdout } = await execution
    const result = JSON.parse(stdout)
    if (
      result?.protocol !== 1 ||
      result.token !== activation.token ||
      result.releaseId !== release.id ||
      result.complete !== true
    )
      throw new Error('Stopped-release preparation did not complete')
    if (
      (await store.activation())?.token !== activation.token ||
      (await store.active())?.id !== release.id
    )
      throw new Error('Stopped-release preparation lost activation ownership')
    await atomicReleaseWrite(
      join(store.root, RECEIPT),
      JSON.stringify({
        protocol: 1,
        token: activation.token,
        releaseId: release.id,
        packageSha256: release.packageSha256,
      })
    )
  } catch {
    await terminateProcessTree(execution.child, 10_000)
    // Child diagnostics can contain private session metadata.
    throw new Error('Stopped-release preparation failed; the healthy release will recover')
  }
}
