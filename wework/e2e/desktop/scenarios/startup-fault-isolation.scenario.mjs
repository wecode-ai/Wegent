import assert from 'node:assert/strict'
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  seedInstalledRelease,
  verifyStartupFaultIsolation,
} from '../modules/startup-fault-isolation.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import { waitForClosedStartupSplash } from '../modules/native-window-state.mjs'

async function reloadWorkbench(control, timeoutMs) {
  const before = control.readyCount
  await control.command('reloadApp', 'body')
  await control.awaitReadyAfter(before, timeoutMs)
  await control.command('waitFor', '[data-testid="app-shell"]', { timeoutMs })
}

async function verifyInitialStorageWriteFailure({ control, data, pid, resultDir, timeoutMs }) {
  const path = join(data, 'renderer-local-storage.json')
  const original = await readFile(path)
  const seed = JSON.parse(original)
  const marker = 'wework.e2e.initialPersistence'
  seed.entries[marker] = 'preserved'
  const seeded = JSON.stringify(seed)
  const backup = `${path}.startup-original`
  const blocked = `${path}.${pid}.tmp`
  try {
    await writeFile(path, seeded)
    await reloadWorkbench(control, timeoutMs)
    await control.command('flushRendererStorage', 'body')
    await mkdir(blocked)
    await rename(path, backup)
    const preserved = await readFile(backup, 'utf8')
    assert.equal(JSON.parse(preserved).entries[marker], 'preserved')
    await reloadWorkbench(control, timeoutMs)
    await assert.rejects(access(path), { code: 'ENOENT' })
    assert.ok(
      (await readFile(backup, 'utf8')) === preserved,
      'Startup changed the preserved browser-state snapshot'
    )

    await rm(blocked, { recursive: true })
    await reloadWorkbench(control, timeoutMs)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).entries[marker], 'preserved')
    await writeFile(
      join(resultDir, 'startup-first-write-result.json'),
      JSON.stringify({ workbenchAvailable: true, seedPreserved: true, persistenceRepaired: true })
    )
  } finally {
    await rm(blocked, { recursive: true, force: true })
    await writeFile(path, original)
    await rm(backup, { force: true })
  }
}

export async function createDesktopScenario({
  resultDir,
  electronUserDataDirectory,
  workbenchReadyTimeoutMs,
}) {
  let appBinary
  let environment
  let replacement
  let appPid
  const preferences = join(electronUserDataDirectory, 'app-preferences.json')
  const preferencesBackup = `${preferences}.startup-original`
  const metadata = JSON.parse(
    await readFile(new URL('../../../electron/package.json', import.meta.url), 'utf8')
  )
  return {
    appEnvironment: { WEWORK_E2E_BACKGROUND_WINDOW: '0' },
    appProcessStarted(child) {
      appPid = child.pid
    },
    async prepareApp(input) {
      appBinary = input.appBinary
      environment = input.appEnvironment
      // A real unreadable settings path must not authorize credential changes or hide the UI.
      await rename(preferences, preferencesBackup)
      await mkdir(preferences)
      if (process.platform === 'win32') {
        assert.equal(environment.WEWORK_RELEASE_SUPERVISED || '', '')
        replacement = await seedInstalledRelease({
          data: electronUserDataDirectory,
          appBinary,
          version: '0.0.0',
          id: 'installed-before-manual-replacement',
        })
      }
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await waitForClosedStartupSplash(control)
      const windowState = JSON.parse(await control.command('getNativeWindowState', 'body'))
      assert.equal(windowState.visible, true, 'Unreadable preferences left the workbench hidden')
      await rm(preferences, { recursive: true })
      await rename(preferencesBackup, preferences)
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ telemetryConsentAsked: true, telemetryEnabled: false }),
      })
      await writeFile(
        join(resultDir, 'startup-preferences-unavailable-result.json'),
        JSON.stringify({ workbenchVisible: true, startupSplashClosed: true })
      )
      if (replacement) {
        const current = await waitForValue(
          async () => {
            const id = (await readFile(join(replacement.releases, 'active'), 'utf8')).trim()
            return JSON.parse(
              await readFile(join(replacement.releases, 'slots', id, 'release.json'), 'utf8')
            )
          },
          release => release.version === metadata.version,
          'The manually replaced host did not reconcile its actual installed release',
          workbenchReadyTimeoutMs
        )
        assert.equal(current.executable, appBinary)
        assert.equal(current.retainedRelease, replacement.descriptor.id)
        assert.equal(
          current.profileRoot,
          await realpath(join(electronUserDataDirectory, 'dsh-core', 'profiles', 'wework-core'))
        )
        assert.equal(await readFile(replacement.descriptorPath, 'utf8'), replacement.original)
        const prepared = JSON.parse(
          await readFile(join(replacement.releases, 'slots', current.id, 'prepared.json'), 'utf8')
        )
        assert.ok(prepared.components.executor)
        assert.ok(prepared.components.codex)
        for (const [id, path] of Object.entries(prepared.components)) {
          if (id !== 'contentSha256') await access(path)
        }
        await writeFile(
          join(resultDir, 'manual-install-reconciliation.json'),
          JSON.stringify({ current, prepared })
        )
      }
      await verifyStartupFaultIsolation({
        appBinary,
        environment,
        resultDir,
        version: metadata.version,
      })
      const durableState = join(electronUserDataDirectory, 'renderer-local-storage.json')
      const original = await readFile(durableState)
      const damaged = '{damaged-durable-state'
      try {
        await writeFile(durableState, damaged)
        const before = control.readyCount
        await control.command('reloadApp', 'body')
        await control.awaitReadyAfter(before, workbenchReadyTimeoutMs)
        await control.command('waitFor', '[data-testid="app-shell"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        assert.equal(
          await readFile(durableState, 'utf8'),
          damaged,
          'Opening the UI replaced damaged user data'
        )
        await writeFile(
          join(resultDir, 'startup-read-only-result.json'),
          JSON.stringify({ workbenchAvailable: true, originalDataPreserved: true })
        )
      } finally {
        await writeFile(durableState, original)
      }
      assert.ok(Number.isInteger(appPid) && appPid > 0)
      await verifyInitialStorageWriteFailure({
        control,
        data: electronUserDataDirectory,
        pid: appPid,
        resultDir,
        timeoutMs: workbenchReadyTimeoutMs,
      })
    },
  }
}
