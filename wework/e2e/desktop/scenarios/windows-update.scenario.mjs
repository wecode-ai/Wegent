import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { createCheckpointTaskFixture } from '../modules/conversation-layout.mjs'
import { resolveDesktopPackageLayout } from '../modules/desktop-package-layout.mjs'
import { ACTIVE_COMPOSER_SELECTOR, CHECKPOINT_TASK_COMPLETION_TEXT } from '../modules/shared.mjs'
import { windowsFeedForArchive } from '../modules/windows-update-fixtures.mjs'
import { waitForStartupProgressEvidence } from '../modules/startup-splash-progress.mjs'

const runFile = promisify(execFile)
const TRANSFER_TIMEOUT_MS = 300_000
const RESTART_TIMEOUT_MS = 240_000

// Electron's ASAR-aware fs treats app.asar as a directory, so recursive copies
// and removals of complete installations fail with "Invalid package". Toggle
// the flag only for these E2E file operations and restore the app's setting.
export async function runWithoutAsar(operation) {
  const previous = process.noAsar
  process.noAsar = true
  try {
    return await operation()
  } finally {
    process.noAsar = previous
  }
}

export async function readInstallationState(installRoot) {
  return JSON.parse(await readFile(join(installRoot, 'update-state.json'), 'utf8'))
}

export async function stopInstallationProcesses(installRoot) {
  // Match owned executable paths, not process names or reusable numeric PIDs.
  await runFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
    $ErrorActionPreference = 'Stop'
    $prefix = [IO.Path]::GetFullPath($env:WEWORK_E2E_OWNED_INSTALL_ROOT).TrimEnd('\\') + '\\'
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $owned = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
      })
      if ($owned.Count -eq 0) { exit 0 }
      $owned | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Owned Windows installation processes did not terminate'
  `,
    ],
    { env: { ...process.env, WEWORK_E2E_OWNED_INSTALL_ROOT: installRoot } }
  )
}

// NSIS still uses MAX_PATH for extracted files. Keep the E2E install root
// short so packaged plugin reference paths stay within that limit.
export function createShortInstallRoot() {
  const base = process.env.LOCALAPPDATA?.trim() || tmpdir()
  return join(base, `w-${process.pid.toString(36)}`)
}

async function waitUntil(read, matches, message, timeoutMs = RESTART_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (matches(value)) return value
    await delay(100)
  }
  throw new Error(message)
}

export async function waitForInstallationActivation(installRoot, version) {
  return waitUntil(
    () =>
      readInstallationState(installRoot).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      }),
    state => state?.active?.version === version && !state.candidate,
    `Windows installation did not activate ${version}`
  )
}

async function readLauncherEvents(installRoot) {
  try {
    return (await readFile(join(installRoot, '.updates', 'launcher.log'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export async function createWindowsUpdateScenario(
  { checkpoint, electronUserDataDirectory, resultDir, workbenchReadyTimeoutMs },
  options = {}
) {
  assert.equal(process.platform, 'win32', 'Windows update E2E requires real Windows')
  const fixtureFile = process.env.WEWORK_E2E_WINDOWS_UPDATE_FIXTURES
  assert.ok(fixtureFile, 'Prepare real Windows update fixtures before running this checkpoint')
  const fixture = JSON.parse(await readFile(resolve(fixtureFile), 'utf8'))
  const installRoot = options.installRoot ?? createShortInstallRoot()
  if (!options.existingInstallation) {
    await runWithoutAsar(() => cp(fixture.baselineRoot, installRoot, { recursive: true }))
  }
  const targetKind = checkpoint === 'windows-update-rollback' ? 'startup-failure' : 'target'
  const targetBytes = await readFile(fixture.artifacts[targetKind].archive)
  const missingBytes =
    checkpoint === 'windows-update-validation'
      ? await readFile(fixture.artifacts['missing-file'].archive)
      : null
  let delivery = checkpoint === 'windows-update-validation' ? 'corrupt' : 'valid'
  let origin = ''
  const requests = []
  const feed = () =>
    windowsFeedForArchive(
      fixture.targetVersion,
      delivery === 'missing' ? missingBytes : targetBytes,
      `${origin}/complete-version.zip`
    )
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', origin).pathname
    requests.push({ path, delivery })
    if (path === '/windows-stable-v2.json' || path === '/windows-beta-v2.json') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(feed()))
    } else if (path === '/complete-version.zip') {
      const bytes = delivery === 'missing' ? missingBytes : targetBytes
      response.setHeader('content-type', 'application/zip')
      response.setHeader('content-length', bytes.length)
      if (delivery === 'corrupt') {
        const corrupted = Buffer.from(bytes)
        corrupted[Math.floor(corrupted.length / 2)] ^= 0xff
        response.end(corrupted)
      } else {
        response.end(bytes)
      }
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  const marker = join(electronUserDataDirectory, 'update-preserved-user-file.txt')
  await writeFile(marker, 'preserve user data across complete-version updates\n')
  let restartDesktopApp
  let taskRow
  let completed = false

  const assertUserData = async control => {
    assert.equal(
      await readFile(marker, 'utf8'),
      'preserve user data across complete-version updates\n'
    )
    await control.command('navigate', 'body', { value: '/' })
    await control.command('waitFor', `[data-testid="${taskRow}"]`, {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', `[data-testid="${taskRow}"]`)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: CHECKPOINT_TASK_COMPLETION_TEXT,
      timeoutMs: workbenchReadyTimeoutMs,
    })
  }

  const check = async control => {
    const update = JSON.parse(await control.command('checkForAppUpdate', 'body'))
    assert.equal(update.version, fixture.targetVersion)
  }

  return {
    usesReleasePackageRuntimeAssets: true,
    appEnvironment: {
      WEWORK_UPDATE_BASE_URL: origin,
      WEWORK_E2E_CLOUD_TOKEN: '',
      // Updates and local startup must remain usable while the cloud is offline.
      WEWORK_E2E_CLOUD_BACKEND_URL: 'http://127.0.0.1:9',
    },

    async resolveLaunchBinary() {
      const layout = await resolveDesktopPackageLayout(join(installRoot, 'WeWork.exe'))
      return layout.stateSource === 'initial-update-state.json' || layout.state?.candidate
        ? layout.launchBinary
        : layout.versionBinary
    },

    prepareApp({ appEnvironment }) {
      for (const key of [
        'WEWORK_EXECUTOR_PATH',
        'WEWORK_EXECUTOR_SIDECAR',
        'CODEX_BINARY_PATH',
        'CODEX_BIN',
      ]) {
        delete appEnvironment[key]
      }
    },

    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      taskRow = await createCheckpointTaskFixture(control, ACTIVE_COMPOSER_SELECTOR)
      await options.beforeUpdate?.(control, { restartDesktopApp, assertUserData, taskRow })
      // Legacy 0.4.x/0.5.x apps legitimately request their old feed at startup.
      // Only requests from the v2 update itself must stay off that protocol.
      const updateRequestBaseline = requests.length
      const baseline = await resolveDesktopPackageLayout(join(installRoot, 'WeWork.exe'))
      const initialState = await readInstallationState(installRoot)
      assert.equal(initialState.active.version, fixture.baselineVersion)
      assert.equal(initialState.candidate, undefined)
      const previousEvents = await readLauncherEvents(installRoot)
      const previousHealthFiles = new Set(
        await readdir(join(installRoot, '.updates', 'health')).catch(error => {
          if (error.code === 'ENOENT') return []
          throw error
        })
      )
      await check(control)
      if (checkpoint === 'windows-update-validation') {
        await assert.rejects(
          control.command('downloadPendingAppUpdate', 'body', {
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
          /checksum|size mismatch/i
        )
        assert.deepEqual(await readInstallationState(installRoot), initialState)
        delivery = 'missing'
        await check(control)
        await assert.rejects(
          control.command('downloadPendingAppUpdate', 'body', {
            timeoutMs: TRANSFER_TIMEOUT_MS,
          }),
          /missing|ENOENT|checksum|size/i
        )
        assert.deepEqual(await readInstallationState(installRoot), initialState)
        delivery = 'valid'
        await check(control)
      }
      await Promise.all([
        control.command('downloadPendingAppUpdate', 'body', { timeoutMs: TRANSFER_TIMEOUT_MS }),
        control.command('downloadPendingAppUpdate', 'body', { timeoutMs: TRANSFER_TIMEOUT_MS }),
      ])
      assert.equal(
        requests.filter(item => item.path === '/complete-version.zip' && item.delivery === 'valid')
          .length,
        1
      )
      assert.deepEqual(
        await readInstallationState(installRoot),
        initialState,
        'Downloading a candidate changed the active installation'
      )
      assert.equal((await stat(baseline.versionBinary)).isFile(), true)
      await control.command('navigate', 'body', { value: '/settings/about' })
      await control.command('waitFor', '[data-testid="about-check-update-button"]')
      const action = await control.command('getText', '[data-testid="about-check-update-button"]')
      if (!action.includes(fixture.targetVersion)) {
        await control.command('click', '[data-testid="about-check-update-button"]')
      }
      await control.command('waitFor', '[data-testid="about-update-status"]', {
        text: fixture.targetVersion,
      })
      const startupLogBytes = (
        await stat(join(electronUserDataDirectory, 'logs', 'wework-main.log'))
      ).size
      const readyCount = control.readyCount
      await control.command('click', '[data-testid="about-check-update-button"]')
      // Installing asks the user to confirm the restart before the handoff.
      await control.command('waitFor', '[data-testid="app-update-restart-confirm"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="app-update-restart-confirm"]')
      await control.awaitReadyAfter(readyCount, RESTART_TIMEOUT_MS)
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const rollback = checkpoint === 'windows-update-rollback'
      const expectedVersion = rollback ? fixture.baselineVersion : fixture.targetVersion
      const state = await waitForInstallationActivation(installRoot, expectedVersion)
      const events = (await readLauncherEvents(installRoot)).slice(previousEvents.length)
      assert.ok(
        events.some(event => event.event === 'trial-started'),
        'No real candidate process was started'
      )
      if (rollback) {
        assert.deepEqual(state.active, initialState.active)
        assert.ok(events.some(event => event.event === 'trial-stopped'))
        assert.equal(
          events.some(event => event.event === 'committed'),
          false
        )
      } else {
        assert.notEqual(state.active.path, initialState.active.path)
        assert.ok(events.some(event => event.event === 'committed'))
        const healthFiles = await readdir(join(installRoot, '.updates', 'health'))
        assert.equal(
          healthFiles.filter(name => name.endsWith('.json') && !previousHealthFiles.has(name))
            .length,
          1,
          'The real renderer and runtime must acknowledge the new version'
        )
      }
      const startup = await waitForStartupProgressEvidence({
        userDataDirectory: electronUserDataDirectory,
        resultDir,
        afterBytes: startupLogBytes,
        name: 'windows-update-startup',
      })
      await assertUserData(control)
      if (checkpoint === 'windows-update-recovery') {
        await stopInstallationProcesses(installRoot)
        await restartDesktopApp({
          afterStop: async () => {
            await rm(join(electronUserDataDirectory, 'managed-components'), {
              recursive: true,
              force: true,
            })
            await rm(join(electronUserDataDirectory, 'dsh-core'), { recursive: true, force: true })
            await rm(join(installRoot, '.updates', 'downloads'), { recursive: true, force: true })
          },
        })
        await assertUserData(control)
        assert.equal(
          (await readInstallationState(installRoot)).active.version,
          fixture.targetVersion
        )
      }
      await control.command('navigate', 'body', { value: '/settings/about' })
      await control.command('waitFor', '[data-testid="about-app-version"]', {
        text: expectedVersion,
      })
      assert.equal(
        requests
          .slice(updateRequestBaseline)
          .some(item => /\.exe$|components-|latest\.yml/.test(item.path)),
        false,
        'A v2 update entered the legacy installer/component protocol'
      )
      await writeFile(
        join(resultDir, 'windows-update-evidence.json'),
        `${JSON.stringify(
          {
            checkpoint,
            baselineVersion: fixture.baselineVersion,
            expectedVersion,
            active: state.active,
            requests,
            events,
            startupStages: startup.stages,
            preservedTaskRow: taskRow,
            actualWindows: true,
            offlineLocalStartup: true,
            fixtureProvenance: fixture.provenance,
          },
          null,
          2
        )}\n`
      )
      completed = true
    },

    async cleanup() {
      await stopInstallationProcesses(installRoot)
      await new Promise(resolvePromise => server.close(resolvePromise))
      await copyFile(
        join(installRoot, '.updates', 'launcher.log'),
        join(resultDir, 'windows-launcher.log')
      ).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      // Keep failures intact for diagnosis; successful full-package copies are large.
      if (completed) await runWithoutAsar(() => rm(installRoot, { recursive: true }))
    },

    diagnostics() {
      return { checkpoint, windowsUpdateRequests: requests }
    },
  }
}

export const createDesktopScenario = createWindowsUpdateScenario
