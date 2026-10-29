import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { createCheckpointTaskFixture } from '../modules/conversation-layout.mjs'
import { resolveDesktopPackageLayout } from '../modules/desktop-package-layout.mjs'
import { ACTIVE_COMPOSER_SELECTOR, CHECKPOINT_TASK_COMPLETION_TEXT } from '../modules/shared.mjs'
import {
  createShortInstallRoot,
  runWithoutAsar,
  stopInstallationProcesses,
  waitForInstallationActivation,
} from './windows-update.scenario.mjs'
import { waitForStartupProgressEvidence } from '../modules/startup-splash-progress.mjs'

function runProcess(command, arguments_, output, options = {}) {
  const child = spawn(command, arguments_, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const complete = new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${basename(command)} exited with code ${code}`))
    )
  })
  // A watcher can fail while the application is still processing the install click.
  // Preserve the rejection for the awaited result without an unhandled rejection.
  complete.catch(() => {})
  child.stdout.on('data', chunk => output.push(chunk.toString()))
  child.stderr.on('data', chunk => output.push(chunk.toString()))
  return { child, complete }
}

async function waitForOwnedApplicationProcess(installRoot, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$prefix = [IO.Path]::GetFullPath($env:WEWORK_E2E_OWNED_INSTALL_ROOT).TrimEnd('\\') + '\\'
         @(Get-CimInstance Win32_Process -Filter "Name='WeWork.exe'" | Where-Object {
           $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
         }).Count`,
      ],
      {
        env: { ...process.env, WEWORK_E2E_OWNED_INSTALL_ROOT: installRoot },
        encoding: 'utf8',
      }
    )
    if (Number(count.trim()) > 0) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  return false
}

// electron-builder's NSIS template terminates every running process whose image
// name matches the packaged executable before installing. Historical installers
// can therefore close an unrelated application that shares the image name (for
// example the daily "Weibo WeWork" build). Refuse to start instead of silently
// terminating someone else's session.
async function assertLegacyInstallerWillNotCloseRunningApplication(legacyInstaller, installRoot) {
  if (process.env.WEWORK_E2E_ALLOW_LEGACY_INSTALLER_APP_TERMINATION === '1') return
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$product = (Get-Item -LiteralPath $env:WEWORK_E2E_LEGACY_INSTALLER).VersionInfo.ProductName
       if (-not $product) { exit 0 }
       $image = "$product.exe"
       $prefix = [IO.Path]::GetFullPath($env:WEWORK_E2E_OWNED_INSTALL_ROOT).TrimEnd('\\') + '\\'
       @(Get-CimInstance Win32_Process | Where-Object {
         $_.Name -ieq $image -and
         $_.ExecutablePath -and
         -not $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
       } | ForEach-Object { $_.ExecutablePath }) -join '|'`,
    ],
    {
      env: {
        ...process.env,
        WEWORK_E2E_LEGACY_INSTALLER: legacyInstaller,
        WEWORK_E2E_OWNED_INSTALL_ROOT: installRoot,
      },
      encoding: 'utf8',
    }
  )
  const running = output
    .split('|')
    .map(value => value.trim())
    .filter(Boolean)
  if (running.length === 0) return
  const executables = [...new Set(running)]
  throw new Error(
    `The historical NSIS installer force-closes every running "${basename(executables[0])}" process. Close ${executables.join(', ')} before running this checkpoint.`
  )
}

// Historical installers leave per-version uninstall entries behind. While
// testing several legacy builds the newest build resolves its installation
// directory from those stale entries and upgrades a previous run's throwaway
// directory instead of the one this checkpoint created.
async function clearStaleE2EInstallRegistrations() {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
       Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
         $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
         $uninstall = [string]$entry.UninstallString
         if ($uninstall -like '*\\AppData\\Local\\w-*') {
           Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
         }
       }
       # electron-builder resolves the previous per-user folder from
       # HKCU\\Software\\<product guid>\\InstallLocation.
       Get-ChildItem 'HKCU:\\Software' -ErrorAction SilentlyContinue | ForEach-Object {
         $location = (Get-ItemProperty -LiteralPath $_.PSPath -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
         if ($location -and $location -like '*\\AppData\\Local\\w-*') {
           Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
         }
       }`,
    ],
    { encoding: 'utf8' }
  )
}

export async function createDesktopScenario({
  electronUserDataDirectory,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  assert.equal(process.platform, 'win32', 'Historical migration requires real Windows installers')
  const legacyInstaller = process.env.WEWORK_E2E_LEGACY_WINDOWS_INSTALLER
  const legacyVersion = process.env.WEWORK_E2E_LEGACY_WINDOWS_VERSION
  const assetsRoot = process.env.WEWORK_E2E_WINDOWS_MIGRATION_ASSETS
  assert.ok(
    legacyInstaller && legacyVersion && assetsRoot,
    'Provide an actual published legacy installer and signed complete migration assets'
  )
  const source = await resolveDesktopPackageLayout(process.env.WEWORK_E2E_APP_BIN)
  assert.ok(source.state, 'The migration target must use the complete-version layout')
  const targetVersion = source.state.active.version
  const channel = targetVersion.includes('-') ? 'beta' : 'stable'
  const installerName = `WeWork_${targetVersion}_windows_x64-setup.exe`
  const installerPath = join(assetsRoot, installerName)
  const sha512 = createHash('sha512')
  await pipeline(createReadStream(installerPath), sha512)
  const installerHash = sha512.digest('base64')
  const installerSize = (await stat(installerPath)).size
  const descriptor = JSON.parse(
    await readFile(join(assetsRoot, 'components-windows-x64.json'), 'utf8')
  )
  assert.equal(descriptor.appVersion, targetVersion)
  assert.equal(descriptor.legacyMigration?.kind, 'self-contained-installer')
  const installRoot = createShortInstallRoot()
  const installOutput = []
  await assertLegacyInstallerWillNotCloseRunningApplication(legacyInstaller, installRoot)
  await clearStaleE2EInstallRegistrations()
  await runProcess(resolve(legacyInstaller), ['/S', `/D=${installRoot}`], installOutput, {
    // NSIS /D is the last unquoted argument, even when the path contains spaces.
    windowsVerbatimArguments: true,
  }).complete
  await stopInstallationProcesses(installRoot)
  const legacyUsesV2 = Boolean(
    (await resolveDesktopPackageLayout(join(installRoot, 'WeWork.exe'))).state
  )
  const updateName = `WeWork_${targetVersion}_windows_x64-update.zip`
  const updateHash = createHash('sha512')
  await pipeline(createReadStream(join(assetsRoot, updateName)), updateHash)
  const updateSha512 = updateHash.digest('base64')
  const updateSize = (await stat(join(assetsRoot, updateName))).size
  let origin = ''
  const requests = []
  const assets = new Set(await readdir(assetsRoot))
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', origin).pathname)
    requests.push(path)
    if (path === `/windows-${channel}-v2.json`) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          schemaVersion: 2,
          version: targetVersion,
          platform: 'windows',
          arch: 'x64',
          dataSchemaVersion: 1,
          url: `${origin}/${updateName}`,
          sha512: updateSha512,
          size: updateSize,
          releaseDate: new Date().toISOString(),
        })
      )
    } else if (path === '/latest.yml' || path === '/beta.yml') {
      response.setHeader('content-type', 'text/yaml')
      response.end(
        [
          `version: ${targetVersion}`,
          'files:',
          `  - url: ${installerName}`,
          `    sha512: ${installerHash}`,
          `    size: ${installerSize}`,
          `path: ${installerName}`,
          `sha512: ${installerHash}`,
          '',
        ].join('\n')
      )
    } else if (path === `/components-${channel}-windows-x64.json`) {
      const components = Object.fromEntries(
        Object.entries(descriptor.components).map(([id, item]) => [
          id,
          {
            version: item.version,
            contentSha256: item.contentSha256,
            archiveSha256: item.archiveSha256,
            entryPath: item.entryPath,
            archiveBytes: 0,
            downloadUrl: `${origin}/${item.assetName}`,
          },
        ])
      )
      Promise.all(
        Object.entries(components).map(async ([id, component]) => {
          component.archiveBytes = (
            await stat(join(assetsRoot, descriptor.components[id].assetName))
          ).size
        })
      )
        .then(() => {
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              appVersion: targetVersion,
              platform: 'windows',
              arch: 'x64',
              channel,
              legacyMigration: descriptor.legacyMigration,
              components,
            })
          )
        })
        .catch(error => response.destroy(error))
    } else if (assets.has(path.slice(1)) && !path.includes('..')) {
      createReadStream(join(assetsRoot, path.slice(1)))
        .on('error', error => response.destroy(error))
        .pipe(response)
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
  let nsis
  const nsisOutput = []
  let completed = false
  let restartDesktopApp = null
  // electron-updater caches downloads under %LOCALAPPDATA% and reuses any
  // matching pending installer. Point the application at a per-run directory
  // so the historical updater always exercises the real download protocol.
  const appLocalAppData = join(resultDir, 'local-appdata')

  return {
    usesReleasePackageRuntimeAssets: true,
    appEnvironment: {
      WEWORK_E2E_DISABLE_COMPONENT_UPDATES: '0',
      WEWORK_UPDATE_BASE_URL: origin,
      WEWORK_E2E_CLOUD_TOKEN: '',
      WEWORK_E2E_CLOUD_BACKEND_URL: 'http://127.0.0.1:9',
      LOCALAPPDATA: appLocalAppData,
    },
    resolveLaunchBinary() {
      return join(installRoot, 'WeWork.exe')
    },
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async prepareApp({ appEnvironment }) {
      for (const key of [
        'WEWORK_EXECUTOR_PATH',
        'WEWORK_EXECUTOR_SIDECAR',
        'CODEX_BINARY_PATH',
        'CODEX_BIN',
      ]) {
        delete appEnvironment[key]
      }
      await mkdir(appLocalAppData, { recursive: true })
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      // Temporary switch for historical clients that cannot seed the E2E model
      // provider. It only covers the preserved-task assertions.
      const taskRow =
        process.env.WEWORK_E2E_SKIP_CHECKPOINT_TASK_FIXTURE === '1'
          ? null
          : await createCheckpointTaskFixture(control, ACTIVE_COMPOSER_SELECTOR)
      await control.command('navigate', 'body', { value: '/settings/about' })
      await control.command('waitFor', '[data-testid="about-app-version"]', { text: legacyVersion })
      const betaEnabled = await control.command(
        'getAttribute',
        '[data-testid="about-beta-update-switch"]',
        { value: 'aria-checked' }
      )
      if ((channel === 'beta') !== (betaEnabled === 'true'))
        await control.command('click', '[data-testid="about-beta-update-switch"]')
      const action = await control.command('getText', '[data-testid="about-check-update-button"]')
      if (!action.includes(targetVersion))
        // The button stays disabled while the channel switch triggers its own
        // update check, so wait for it instead of racing the renderer.
        await control.command('clickWhenEnabled', '[data-testid="about-check-update-button"]', {
          timeoutMs: 60_000,
        })
      await control.command('waitFor', '[data-testid="about-update-status"]', {
        text: targetVersion,
        timeoutMs: 30_000,
      })
      await control.command('downloadPendingAppUpdate', 'body', { timeoutMs: 300_000 })
      assert.ok(
        requests.includes(`/${legacyUsesV2 ? updateName : installerName}`),
        'The historical updater did not download its real protocol artifact'
      )
      if (!legacyUsesV2 && legacyVersion !== '0.4.0') {
        assert.ok(
          requests.includes(`/components-${channel}-windows-x64.json`),
          'The historical client did not exercise its real component preparation protocol'
        )
        const componentState = JSON.parse(
          await readFile(
            join(electronUserDataDirectory, 'managed-components', 'state.json'),
            'utf8'
          )
        )
        assert.equal(componentState.pending.appVersion, targetVersion)
      }
      if (!legacyUsesV2)
        nsis = runProcess(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            fileURLToPath(new URL('../modules/windows-nsis-controls.ps1', import.meta.url)),
            '-TimeoutSeconds',
            '300',
            '-EvidencePath',
            join(resultDir, 'nsis-controls.json'),
          ],
          nsisOutput
        )
      const afterBytes = await stat(join(electronUserDataDirectory, 'logs', 'wework-main.log'))
        .then(value => value.size)
        .catch(error => {
          if (error.code === 'ENOENT') return 0
          throw error
        })
      await control.command('clickWhenEnabled', '[data-testid="about-check-update-button"]', {
        timeoutMs: 60_000,
      })
      // 0.5.x and v2 clients ask for restart confirmation before handing off.
      await control.command('waitFor', '[data-testid="app-update-restart-confirm"]', {
        timeoutMs: 30_000,
      })
      await control.command('click', '[data-testid="app-update-restart-confirm"]')
      await nsis?.complete
      const state = await waitForInstallationActivation(installRoot, targetVersion)
      assert.equal(state.active.version, targetVersion)
      assert.equal(state.candidate, undefined)
      assert.ok(
        await waitForOwnedApplicationProcess(installRoot),
        'The NSIS upgrade did not relaunch the updated application'
      )
      // The installer restarts the application from the shell, which drops the
      // E2E environment and would attach it to the developer profile. Stop that
      // instance and relaunch through the harness with the isolated profile.
      await stopInstallationProcesses(installRoot)
      assert.ok(restartDesktopApp, 'The desktop runner did not expose a restart hook')
      await restartDesktopApp()
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const startup = await waitForStartupProgressEvidence({
        userDataDirectory: electronUserDataDirectory,
        resultDir,
        name: 'windows-migration-startup',
        afterBytes,
      })
      if (legacyUsesV2) {
        assert.equal(requests.includes(`/${installerName}`), false)
        assert.equal(
          requests.some(path => path.startsWith('/components-')),
          false
        )
        const journal = await readFile(join(installRoot, '.updates', 'launcher.log'), 'utf8')
        assert.ok(
          journal
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
            .some(
              event => event.event === 'committed' && event.detail === `version=${targetVersion}`
            ),
          'The actual previous v2 release did not commit through its native launcher'
        )
        await writeFile(join(resultDir, 'windows-launcher.log'), journal)
      }
      if (taskRow) {
        await control.command('navigate', 'body', { value: '/' })
        await control.command('click', `[data-testid="${taskRow}"]`)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: CHECKPOINT_TASK_COMPLETION_TEXT,
          timeoutMs: workbenchReadyTimeoutMs,
        })
      }
      await control.command('navigate', 'body', { value: '/settings/about' })
      await control.command('waitFor', '[data-testid="about-app-version"]', { text: targetVersion })
      await writeFile(
        join(resultDir, 'windows-migration-evidence.json'),
        `${JSON.stringify(
          {
            legacyVersion,
            targetVersion,
            legacyUsesV2,
            legacyInstaller: basename(legacyInstaller),
            requests,
            active: state.active,
            startupStages: startup.stages,
            preservedTaskRow: taskRow,
            entry: legacyUsesV2
              ? 'Actual published previous v2 release, complete update ZIP, native launcher, and health startup'
              : 'Actual historical in-app updater, component preparation, NSIS UI, and new application startup',
          },
          null,
          2
        )}\n`
      )
      completed = true
    },
    async cleanup() {
      nsis?.child.kill()
      await stopInstallationProcesses(installRoot)
      await new Promise(resolvePromise => server.close(resolvePromise))
      await writeFile(
        join(resultDir, 'nsis-process.log'),
        [...installOutput, ...nsisOutput].join('')
      )
      if (completed) await runWithoutAsar(() => rm(installRoot, { recursive: true }))
    },
    diagnostics() {
      return { legacyVersion, targetVersion, migrationRequests: requests }
    },
  }
}
