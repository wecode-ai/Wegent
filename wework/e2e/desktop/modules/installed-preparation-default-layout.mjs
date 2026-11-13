import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { INSTALLED_PREPARATION_ARGUMENT } from '../../../electron/src/runtime/installed-preparation-contract.mjs'
import { parseStartupEvents } from './cold-package-startup.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
import { readPackagedNamespace } from './packaged-resources.mjs'
import { upgradeUserEnvironment } from './upgrade-user-environment.mjs'
import { stopProcess } from '../process-lifecycle.mjs'

const INSTALL_PREPARATION_TIMEOUT_MS = 600_000
const STARTUP_TIMEOUT_MS = 180_000

/** Exercise the installer entry, default data migration, and first normal launch with a real package. */
export async function verifyDefaultLayoutInstalledPreparation({
  appBinary,
  appEnvironment,
  resultDir,
}) {
  const root = join(resultDir, 'default-layout-install-preparation')
  const home = join(root, 'home')
  const appData =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : join(root, process.platform === 'win32' ? 'app-data' : 'xdg-config')
  const localAppData = join(root, 'local-app-data')
  const applicationId = 'io.wecode.wework.e2e.default-layout'
  const namespace = (await readPackagedNamespace(appBinary, appEnvironment)) || 'default'
  const userData = join(home, '.wegent', 'workbench', 'wework', namespace, 'user-data')
  const source = join(appData, applicationId)
  await Promise.all([mkdir(home, { recursive: true }), mkdir(appData, { recursive: true })])
  if (process.platform === 'win32') await mkdir(localAppData, { recursive: true })
  await assert.rejects(lstat(userData), { code: 'ENOENT' })
  const environment = {
    ...upgradeUserEnvironment(appEnvironment, home),
    WEWORK_APP_IDENTIFIER: applicationId,
  }
  if (process.platform === 'darwin') environment.CFFIXED_USER_HOME = home
  if (process.platform === 'win32') {
    environment.APPDATA = appData
    environment.LOCALAPPDATA = localAppData
    environment.USERPROFILE = home
  }
  if (process.platform === 'linux') environment.XDG_CONFIG_HOME = appData
  for (const key of Object.keys(environment)) {
    if (key.startsWith('WEWORK_E2E_') || key === 'VITE_WEWORK_E2E') delete environment[key]
  }

  const preparation = spawnSync(
    appBinary,
    [INSTALLED_PREPARATION_ARGUMENT, ...resolveElectronLaunchArguments()],
    {
      env: environment,
      encoding: 'utf8',
      timeout: INSTALL_PREPARATION_TIMEOUT_MS,
      windowsHide: true,
    }
  )
  assert.equal(
    preparation.status,
    0,
    `Default-layout installation preparation failed:\n${preparation.stderr}`
  )
  assert.equal((await lstat(source)).isSymbolicLink(), true)
  const status = JSON.parse(
    await readFile(join(userData, 'logs', 'install-preparation.json'), 'utf8')
  )
  assert.equal(status.runtimeRoot, join(userData, 'managed-runtimes', 'dsh'))
  assert.equal(status.preparationDirectory, join(userData, 'install-preparations', status.version))
  assert.equal(
    status.profileRoot,
    join(status.preparationDirectory, 'dsh-core', 'profiles', 'wework-core')
  )
  assert.equal((await lstat(status.profileRoot)).isDirectory(), true)
  await assert.rejects(lstat(join(userData, 'dsh-core')), { code: 'ENOENT' })
  assert.equal((await lstat(join(status.preparationDirectory, 'prepared.json'))).isFile(), true)

  const child = spawn(appBinary, resolveElectronLaunchArguments(), {
    env: { ...environment, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    const startupLogPaths = [
      join(userData, 'logs', 'wework-main.log'),
      join(home, '.wegent', 'workbench', 'wework', namespace, 'electron-logs', 'wework-main.log'),
    ]
    for (;;) {
      assert.equal(
        child.exitCode,
        null,
        `Default-layout first launch exited before showing the window:\n${stdout}\n${stderr}`
      )
      assert.ok(
        Date.now() < deadline,
        `Default-layout first launch did not reach main-window-show:\n${stdout}\n${stderr}`
      )
      let ready = false
      for (const startupLogPath of startupLogPaths) {
        const startupLog = await readFile(startupLogPath, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return ''
          throw error
        })
        ready = parseStartupEvents(startupLog).some(
          event => event.step === 'main-window-show' && event.status === 'completed'
        )
        if (ready) break
      }
      if (ready) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    assert.doesNotMatch(`${stdout}\n${stderr}`, /Application data migration target conflict/)
  } finally {
    await stopProcess(child)
  }
  assert.equal(
    await realpath(join(userData, 'dsh-core', 'profiles', 'wework-core')),
    await realpath(status.profileRoot)
  )
  await assert.rejects(lstat(join(status.preparationDirectory, 'prepared.json')), {
    code: 'ENOENT',
  })
  const evidence = {
    defaultUserData: true,
    migratedBeforePreparation: true,
    isolatedPreparation: true,
    preparedProfileApplied: true,
    firstLaunchReady: true,
  }
  await writeFile(
    join(resultDir, 'default-layout-install-preparation.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  return evidence
}
