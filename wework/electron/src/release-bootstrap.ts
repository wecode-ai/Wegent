import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  resolveWorkbenchCodexHome,
  resolveWorkbenchPaths,
} from './runtime/workbench-environment.js'
import { optionalText, ReleaseStore, sameReleasePath } from './runtime/release-store.js'
import { restoreReleaseData } from './runtime/release-snapshot.js'
import { currentCoreProfile, selectReleaseProfile } from './runtime/release-profile.js'
import { releaseBridgeUserData } from './runtime/release-handoff.js'
import { recordReleaseDiagnostic } from './runtime/release-diagnostics.js'
import { enterInstalledMacosRelease } from './runtime/macos-release-installation.js'
import { acquireReleaseStartup } from './runtime/release-startup-owner.js'
import {
  assertReleaseAfterStopReady,
  prepareReleaseAfterStop,
  type AfterStopMetadata,
} from './runtime/release-after-stop.js'

type ReleaseMetadata = AfterStopMetadata & { version?: string; weworkExecutorNamespace?: string }

export async function routeRelease(
  metadata: ReleaseMetadata,
  forwardedArguments: () => string[],
  failStartup: (error: unknown) => void
): Promise<boolean> {
  if (!app.isPackaged) return true
  const dataDirectory =
    process.env.WEWORK_USER_DATA_DIR?.trim() ||
    join(
      resolveWorkbenchPaths({
        environment: process.env,
        metadata,
        homeDirectory: app.getPath('home'),
      }).desktop,
      'user-data'
    )
  const root = join(dataDirectory, 'releases')
  const release = await acquireReleaseStartup(
    root,
    join(
      process.resourcesPath,
      process.platform === 'win32' ? 'wework-launcher.exe' : 'wework-launcher'
    ),
    error => {
      recordReleaseDiagnostic('release-startup-lock-lost', { message: error.message }, true)
      process.env.WEWORK_STARTUP_RECOVERY = error.message
      app.relaunch({ args: forwardedArguments() })
      app.exit(1)
    }
  )
  const failRouting = (error: unknown): void => {
    void release().then(() => failStartup(error), failStartup)
  }
  let startMain: boolean
  try {
    startMain = await routeSelectedRelease(
      metadata,
      dataDirectory,
      root,
      forwardedArguments,
      failRouting
    )
  } catch (error) {
    await release()
    throw error
  }
  if (startMain) await release()
  return startMain
}

async function routeSelectedRelease(
  metadata: ReleaseMetadata,
  dataDirectory: string,
  root: string,
  forwardedArguments: () => string[],
  failStartup: (error: unknown) => void
): Promise<boolean> {
  const store = new ReleaseStore(root)
  const supervisedId = process.env.WEWORK_RELEASE_SUPERVISED
  const recoveryToken = process.env.WEWORK_RELEASE_RECOVERY
  delete process.env.WEWORK_RELEASE_SUPERVISED
  delete process.env.WEWORK_RELEASE_RECOVERY
  const physicalRollback =
    process.platform === 'darwin' ? await optionalText(join(root, 'macos-rollback')) : null
  const versionedPayload = await store.isSlotExecutable(process.execPath)
  if (
    process.platform === 'darwin' &&
    !supervisedId &&
    !recoveryToken &&
    !versionedPayload &&
    !physicalRollback
  ) {
    // Only the installed package owns ordinary startup. A delayed recovery or
    // versioned bridge must still route the selected release after its journal
    // has been finalized; it must never open data in the rejected host.
    try {
      if (!(await store.activation())) {
        await bindInstalledReleaseComponents(store, metadata)
        return true
      }
    } catch (error) {
      console.warn('[release-bootstrap] Cannot read update history; starting installed app', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      return true
    }
  }
  if (
    process.env.WEWORK_RELEASE_ROOT &&
    resolve(process.env.WEWORK_RELEASE_ROOT) !== resolve(root) &&
    (await realpath(process.env.WEWORK_RELEASE_ROOT)) !== (await realpath(root))
  ) {
    throw new Error('Release root does not match the application data directory')
  }
  const active = await store.active()
  const runningSelectedHost = active
    ? await sameReleasePath(active.executable, process.execPath)
    : false
  // An external installer can replace an installed Windows host in place.
  // Its old descriptor no longer identifies the bytes at that path. Let the
  // replacement start normally; the updater registers its current composition.
  // Never bypass a supervised launch or an unfinished activation/rollback.
  if (
    process.platform === 'win32' &&
    !supervisedId &&
    !recoveryToken &&
    !versionedPayload &&
    active?.id.startsWith('installed-') &&
    active.version !== metadata.version &&
    runningSelectedHost &&
    !(await store.activation())
  )
    return true
  const bridge = await optionalText(join(root, 'bridge'))
  // The installed entry owns restoring physical Contents even when activation
  // failed or rollback selected an older payload. A delivered recovery bridge
  // may not contain a native installer capable of restoring that application.
  const installedMacosEntry = active?.macosInstallation && runningSelectedHost
  if (
    !supervisedId &&
    bridge &&
    !(await sameReleasePath(bridge, process.execPath)) &&
    !installedMacosEntry
  ) {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    if (!existsSync(bridge)) throw new Error('The healthy Wework recovery executable is missing')
    const bridgeUserData = await releaseBridgeUserData(store, bridge, dataDirectory)
    // An old installed entry only forwards. Recovery must use the latest healthy
    // release, which understands snapshots created by that release's updater.
    void app
      .whenReady()
      .then(() => {
        if (bridgeUserData) {
          process.env.WEWORK_USER_DATA_DIR = bridgeUserData
          process.env.WEWORK_RELEASE_ROOT = root
          recordReleaseDiagnostic(
            'release-bridge-handoff',
            { bridge, dataDirectory: bridgeUserData },
            true
          )
        }
        app.relaunch({ execPath: bridge, args: forwardedArguments() })
        app.exit(0)
      })
      .catch(failStartup)
    return false
  }
  if (!active) return true
  const supervised = supervisedId === active.id
  if (supervised) {
    if (metadata.version !== active.version)
      throw new Error('The installed host does not match the selected release version')
    await assertReleaseAfterStopReady(store, active, metadata)
    await store.repairMacosActivationSource(active)
    if (process.platform === 'darwin' && active.macosInstallation && !runningSelectedHost) {
      app.setActivationPolicy('prohibited')
    }
    await enterInstalledMacosRelease(store, active, process.resourcesPath)
  }
  // Only the independent launcher grants a child this one-use handoff.
  if (supervised && runningSelectedHost) {
    process.env.WEWORK_HARNESS_RUNTIME_ROOT = active.runtimeRoot
    process.env.WEWORK_ACTIVE_RELEASE_ID = active.id
    process.env.WEWORK_RELEASE_ROOT = root
    process.env.WEWORK_COMPONENT_DATA_DIRECTORY =
      active.componentDataDirectory ?? store.slot(active.id)
    const activation = await store.activation()
    const live = currentCoreProfile(dataDirectory)
    const { lstat } = await import('node:fs/promises')
    const usesOriginalProfile =
      active.id.startsWith('installed-') &&
      !activation &&
      existsSync(live) &&
      !(await lstat(live)).isSymbolicLink()
    if (
      !usesOriginalProfile &&
      (existsSync(active.profileRoot) || !active.id.startsWith('installed-'))
    ) {
      await selectReleaseProfile(dataDirectory, active.profileRoot, join(root, 'legacy-profile'))
    } else if (!existsSync(currentCoreProfile(dataDirectory))) {
      throw new Error('Installed release profile is missing')
    }
    // Faults are opt-in only in the isolated desktop E2E environment. They kill
    // or hold the real target process before it can open mutable application data.
    if (
      process.env.WEWORK_E2E_CONTROL_URL &&
      process.env.WEWORK_E2E_RELEASE_FAILURE_VERSION === metadata.version
    ) {
      app.exit(2)
      return false
    }
    if (activation)
      await import('./runtime/release-store.js').then(({ atomicReleaseWrite }) =>
        atomicReleaseWrite(join(root, 'data-opened'), activation.token)
      )
    return true
  }
  // Electron emits ready only after its ESM entry finishes evaluating. Awaiting
  // readiness through the entry's top-level await deadlocks the stable bridge.
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  void app
    .whenReady()
    .then(() => launchSelectedRelease(store, dataDirectory, root, metadata, forwardedArguments))
    .catch(failStartup)
  return false
}

async function bindInstalledReleaseComponents(
  store: ReleaseStore,
  metadata: { version?: string }
): Promise<void> {
  const release = await store.active()
  if (
    !release ||
    release.version !== metadata.version ||
    resolve(release.executable) !== resolve(process.execPath) ||
    !release.macosInstallation
  )
    return
  await enterInstalledMacosRelease(store, release, process.resourcesPath)
  process.env.WEWORK_HARNESS_RUNTIME_ROOT = release.runtimeRoot
  process.env.WEWORK_ACTIVE_RELEASE_ID = release.id
  process.env.WEWORK_RELEASE_ROOT = store.root
  process.env.WEWORK_COMPONENT_DATA_DIRECTORY =
    release.componentDataDirectory ?? store.slot(release.id)
}

async function launchSelectedRelease(
  store: ReleaseStore,
  dataDirectory: string,
  root: string,
  metadata: ReleaseMetadata,
  forwardedArguments: () => string[]
): Promise<void> {
  const activation = await store.activation()
  if (activation?.rollbackRequested) {
    // Confirmation was recorded before beginning this manual rollback. Resume
    // an interrupted restore even if the target's earlier healthy marker exists.
    if (activation.restoreRequired)
      await restoreReleaseData(
        dataDirectory,
        root,
        activation.snapshot,
        process.env.WEGENT_EXECUTOR_HOME?.trim() || dataDirectory
      )
    await store.rollback()
  } else if (
    activation &&
    (await optionalText(join(root, 'attempted'))) === activation.token &&
    ((await optionalText(join(root, 'failed'))) === activation.token ||
      (await optionalText(join(root, 'healthy'))) === activation.token)
  ) {
    const healthy = await optionalText(join(root, 'healthy'))
    if (healthy === activation.token) {
      await store.confirm(activation.to)
    } else {
      // Also handles a machine reboot or interruption between journal and pointer writes.
      if (
        activation.restoreRequired &&
        (await optionalText(join(root, 'data-opened'))) === activation.token
      ) {
        const zh = app.getLocale().startsWith('zh')
        const answer = await dialog.showMessageBox({
          type: 'warning',
          title: 'Wework',
          message: zh
            ? '新版未能启动，需要恢复更新前的数据才能回退。'
            : 'The new version could not start. Rollback requires restoring pre-update data.',
          detail: zh
            ? '恢复将移除更新后新增的本地数据；这些数据会另外保留。源码仓库和云端数据不受影响。'
            : 'New local data will be preserved separately. Repositories and cloud records are unaffected.',
          buttons: zh ? ['稍后处理', '恢复并回退'] : ['Decide later', 'Restore and roll back'],
          defaultId: 0,
          cancelId: 0,
        })
        if (answer.response !== 1) {
          throw new Error(
            zh
              ? '更新数据等待恢复确认，原始数据已保留。'
              : 'Update recovery needs confirmation. Original data is preserved.'
          )
        }
        await restoreReleaseData(
          dataDirectory,
          root,
          activation.snapshot,
          process.env.WEGENT_EXECUTOR_HOME?.trim() || dataDirectory
        )
      }
      await store.rollback()
    }
  }
  const active = await store.active()
  if (!active) throw new Error('Active release is missing')
  try {
    const homeOptions = {
      environment: process.env,
      metadata,
      homeDirectory: app.getPath('home'),
    }
    const paths = resolveWorkbenchPaths(homeOptions)
    await prepareReleaseAfterStop(store, active, dataDirectory, {
      workbenchRoot: paths.root,
      codexHome: resolveWorkbenchCodexHome(homeOptions),
    })
  } catch (error) {
    const pending = await store.activation()
    if (!pending || pending.to !== active.id) throw error
    recordReleaseDiagnostic('after-stop-preparation-failed', { releaseId: active.id }, true)
    const { atomicReleaseWrite } = await import('./runtime/release-store.js')
    await atomicReleaseWrite(join(root, 'attempted'), pending.token)
    await atomicReleaseWrite(join(root, 'failed'), pending.token)
    // Reuse the existing compatible rollback / explicit restore-consent flow.
    await launchSelectedRelease(store, dataDirectory, root, metadata, forwardedArguments)
    return
  }
  // Legacy Windows entries resolve the release root above user-data and compare
  // its lexical path with the launcher's handoff. Pass the selected store owner
  // explicitly on every platform, including interrupted rollback recovery.
  const selectedUserData = await releaseBridgeUserData(store, active.executable, dataDirectory)
  if (!selectedUserData) throw new Error('The selected release does not own its launch data')
  process.env.WEWORK_USER_DATA_DIR = selectedUserData
  process.env.WEWORK_RELEASE_ROOT = root
  const bridge = (await optionalText(join(root, 'bridge'))) || process.execPath
  const launcher =
    process.platform === 'darwin' && active.macosInstallation
      ? join(process.resourcesPath, 'wework-launcher')
      : join(
          dirname(bridge),
          process.platform === 'darwin'
            ? '../Resources/wework-launcher'
            : process.platform === 'win32'
              ? 'resources/wework-launcher.exe'
              : 'resources/wework-launcher'
        )
  if (!existsSync(launcher)) throw new Error('Independent Wework launcher is missing')
  // Electron's relaunch helper waits for the stable entry to exit and release native locks.
  app.relaunch({ execPath: resolve(launcher), args: [root, bridge, ...forwardedArguments()] })
  app.exit(0)
}
