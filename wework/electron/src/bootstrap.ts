import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveWorkbenchPaths } from './runtime/workbench-environment.js'
import { optionalText, ReleaseStore } from './runtime/release-store.js'
import { restoreReleaseData } from './runtime/release-snapshot.js'
import { currentCoreProfile, selectReleaseProfile } from './runtime/release-profile.js'

const pendingUrls: string[] = []
const captureUrl = (event: Electron.Event, url: string): void => {
  event.preventDefault()
  pendingUrls.push(url)
}
app.on('open-url', captureUrl)
const forwardedArguments = (): string[] => [...process.argv.slice(1), ...pendingUrls]

const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const packaged = app.isPackaged

try {
  if (await routeRelease()) {
    app.removeListener('open-url', captureUrl)
    process.argv.push(...pendingUrls)
    await import('./main.js')
  }
} catch (error) {
  failStartup(error)
}

function failStartup(error: unknown): void {
  console.error('[release-bootstrap]', error instanceof Error ? error.message : 'Startup failed')
  dialog.showErrorBox('Wework', error instanceof Error ? error.message : 'Startup failed')
  app.exit(1)
}

async function routeRelease(): Promise<boolean> {
  if (!packaged) return true
  const dataDirectory =
    process.env.WEWORK_USER_DATA_DIR?.trim() ||
    resolveWorkbenchPaths({
      environment: process.env,
      metadata,
      homeDirectory: app.getPath('home'),
    }).desktop
  const root = join(dataDirectory, 'releases')
  if (
    process.env.WEWORK_RELEASE_ROOT &&
    resolve(process.env.WEWORK_RELEASE_ROOT) !== resolve(root)
  ) {
    throw new Error('Release root does not match the application data directory')
  }
  const store = new ReleaseStore(root)
  const supervisedId = process.env.WEWORK_RELEASE_SUPERVISED
  delete process.env.WEWORK_RELEASE_SUPERVISED
  const bridge = await optionalText(join(root, 'bridge'))
  if (!supervisedId && bridge && resolve(bridge) !== resolve(process.execPath)) {
    // An old installed entry only forwards. Recovery must use the latest healthy
    // release, which understands snapshots created by that release's updater.
    void app
      .whenReady()
      .then(() => {
        app.relaunch({ execPath: bridge, args: forwardedArguments() })
        app.exit(0)
      })
      .catch(failStartup)
    return false
  }
  const active = await store.active()
  if (!active) return true
  const supervised = supervisedId === active.id
  // Only the independent launcher grants a child this one-use handoff.
  if (supervised && resolve(active.executable) === resolve(process.execPath)) {
    process.env.WEWORK_HARNESS_RUNTIME_ROOT = active.runtimeRoot
    process.env.WEWORK_ACTIVE_RELEASE_ID = active.id
    process.env.WEWORK_RELEASE_ROOT = root
    process.env.WEWORK_COMPONENT_DATA_DIRECTORY = store.slot(active.id)
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
  void app
    .whenReady()
    .then(() => launchSelectedRelease(store, dataDirectory, root))
    .catch(failStartup)
  return false
}

async function launchSelectedRelease(
  store: ReleaseStore,
  dataDirectory: string,
  root: string
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
          buttons: zh ? ['退出', '恢复并回退'] : ['Quit', 'Restore and roll back'],
          defaultId: 0,
          cancelId: 0,
        })
        if (answer.response !== 1) {
          app.exit(0)
          return
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
  const bridge = (await optionalText(join(root, 'bridge'))) || process.execPath
  const launcher = join(
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
