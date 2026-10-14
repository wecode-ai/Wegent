import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { packagedResourcesRoot } from './workbench-schema-compatibility.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// Keep subprocess failures useful after transient verification files are removed.
export function startupRecoveryFailureDiagnostic(value = {}, error = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {}
  const phases = [
    'entered',
    'fixtures',
    'app-ready',
    'load-services',
    'verify-retained',
    'verify-reset',
    'create-splash',
    'load-splash',
    'open-confirmation',
    'capture-confirmation',
    'submit-recovery',
    'verify-cleanup-failure',
    'await-relaunch',
  ]
  const names = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AssertionError']
  const codes = [
    'ENOENT',
    'EACCES',
    'EPERM',
    'EBUSY',
    'EEXIST',
    'ENOTDIR',
    'ERR_ASSERTION',
    'ERR_MODULE_NOT_FOUND',
    'MODULE_NOT_FOUND',
    'ERR_UNKNOWN_BUILTIN_MODULE',
  ]
  return {
    phase: phases.includes(value.phase) ? value.phase : 'unknown',
    verificationMode: ['runtime', 'user', 'verify'].includes(value.verificationMode)
      ? value.verificationMode
      : 'unknown',
    errorName: names.includes(value.errorName) ? value.errorName : 'unknown',
    errorCode: codes.includes(value.errorCode) ? value.errorCode : 'unknown',
    exitCode: Number.isInteger(error.code) ? error.code : null,
    killed: error.killed === true,
    signal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(error.signal)
      ? error.signal
      : null,
  }
}

export async function executeStartupRecoveryChild(
  executable,
  args,
  options,
  { root, resultDir, execute = promisify(execFile) }
) {
  try {
    return await execute(executable, args, options)
  } catch (error) {
    let evidence = {}
    try {
      evidence = JSON.parse(await readFile(join(root, 'failure-diagnostic.json'), 'utf8'))
    } catch {
      /* Preserve the subprocess failure when no child evidence was written. */
    }
    try {
      await writeFile(
        join(resultDir, 'startup-reset-failure.json'),
        JSON.stringify(startupRecoveryFailureDiagnostic(evidence, error), null, 2) + '\n'
      )
    } catch {
      /* Diagnostic collection must never replace the original failure. */
    }
    throw error
  }
}

export function writeStartupRecoveryDiagnostic(file, diagnostic, write) {
  try {
    write(file, JSON.stringify(diagnostic))
  } catch {
    // Diagnostic collection must not affect verification or process shutdown.
  }
}

// Run the production splash, preload, recovery service, and filesystem stores in
// isolated Electron processes. Each reset must really relaunch before verification.
export async function verifyStartupRecovery({ appBinary, resultDir, electronRoot }) {
  const root = join(resultDir, 'startup-recovery')
  await mkdir(root, { recursive: true })
  const input = {
    root,
    electronRoot: electronRoot ?? join(packagedResourcesRoot(appBinary), 'app.asar'),
  }
  const scriptPath = join(root, 'verify.cjs')
  await writeFile(
    scriptPath,
    `globalThis.__weworkRecordRecoveryDiagnostic = ${writeStartupRecoveryDiagnostic.toString()};
  (${runRecoveryVerification.toString()})().catch(error => {
    const path = require('node:path');
    const input = JSON.parse(process.argv[2]);
    const diagnostic = ${startupRecoveryFailureDiagnostic.toString()}(
      { ...globalThis.__weworkRecoveryDiagnostic, errorName: error?.name, errorCode: error?.code });
    globalThis.__weworkRecordRecoveryDiagnostic(
      path.join(input.root, 'failure-diagnostic.json'), diagnostic, require('node:fs').writeFileSync);
    require('electron').app.exit(1);
  });`
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const args = [scriptPath, JSON.stringify(input), 'runtime', ...resolveElectronLaunchArguments()]
  await executeStartupRecoveryChild(
    require('electron'),
    args,
    {
      env: environment,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
    { root, resultDir }
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    let evidence
    try {
      evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (evidence) {
      assert.equal(evidence.error, undefined, evidence.error)
      assert.equal(evidence.runtimeResetPreservesUserState, true)
      assert.equal(evidence.userResetPreservesTasksAndSessions, true)
      assert.equal(evidence.realRelaunches, 2)
      assert.equal(evidence.failedCleanupRetried, true)
      await writeFile(
        join(resultDir, 'startup-reset-evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`
      )
      for (const name of [
        'runtime-confirmation.png',
        'user-confirmation.png',
        'cleanup-failure.png',
        'recovery.log',
      ]) {
        await copyFile(join(root, name), join(resultDir, `startup-reset-${name}`))
      }
      return evidence
    }
    await delay(100)
  }
  assert.fail('Startup recovery did not finish its real Electron relaunches within 60 seconds')
}

async function runRecoveryVerification() {
  const assert = require('node:assert/strict')
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const { pathToFileURL } = require('node:url')
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const input = JSON.parse(process.argv[2])
  const phase = process.argv[3]
  const root = input.root
  const recordPhase = value => {
    globalThis.__weworkRecoveryDiagnostic = { phase: value, verificationMode: phase }
    globalThis.__weworkRecordRecoveryDiagnostic(
      path.join(root, 'failure-diagnostic.json'),
      globalThis.__weworkRecoveryDiagnostic,
      require('node:fs').writeFileSync
    )
  }
  recordPhase('entered')
  const dataDirectory = path.join(root, 'user-data')
  const paths = {
    dataDirectory,
    codexHome: path.join(root, 'codex'),
    claudeHome: path.join(root, 'claude'),
    capabilitiesHome: path.join(root, 'capabilities'),
  }
  const profile = path.join(dataDirectory, 'dsh-core/profiles/wework-core')
  const pluginPath = path.join(profile, 'node_modules/recovery-user-plugin/index.js')
  const sessionPath = path.join(paths.codexHome, 'sessions/task.jsonl')
  const taskPath = path.join(root, 'data/tasks.sqlite')
  const projectPath = path.join(root, 'workspace/project/index.ts')
  const manifestPath = path.join(paths.capabilitiesHome, 'manifest-v2.json')
  const userState = {
    version: 1,
    entries: { auth_token: 'synthetic-token', 'wework.workspaceTabs.v3:user': 'layout' },
  }
  const put = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, value)
  }
  recordPhase('fixtures')
  if (phase === 'runtime') {
    await put(path.join(profile, '.wework-runtime.json'), 'broken stamp')
    await put(path.join(profile, 'node_modules/@wegent/dsh-app-wework/index.js'), 'broken built-in')
    await put(
      path.join(profile, 'package.json'),
      JSON.stringify({ dependencies: { 'recovery-user-plugin': '1.0' } })
    )
    await put(pluginPath, 'user plugin')
    await put(sessionPath, 'saved conversation')
    await put(projectPath, 'project source')
    await put(
      manifestPath,
      JSON.stringify({ version: 2, skills: { skill: {} }, plugins: { plugin: {} } })
    )
    await put(path.join(dataDirectory, 'renderer-local-storage.json'), JSON.stringify(userState))
    await put(path.join(dataDirectory, 'app-preferences.json'), JSON.stringify({ theme: 'dark' }))
    await put(path.join(dataDirectory, 'cloud-credentials.json'), 'synthetic credentials')
    await put(path.join(paths.codexHome, 'plugins/installed.json'), 'installed plugin')
    await fs.mkdir(path.dirname(taskPath), { recursive: true })
    const { DatabaseSync } = require('node:sqlite')
    const database = new DatabaseSync(taskPath)
    database.exec(
      "CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT); INSERT INTO tasks VALUES('saved-task', 'Retained task')"
    )
    database.close()
  }
  app.setPath('userData', dataDirectory)
  recordPhase('app-ready')
  await app.whenReady()
  recordPhase('load-services')
  const metadata = JSON.parse(
    await fs.readFile(path.join(input.electronRoot, 'package.json'), 'utf8')
  )
  const dist = path.join(input.electronRoot, path.dirname(metadata.main))
  const load = name => import(pathToFileURL(path.join(dist, 'host', name + '.js')).href)
  const { StartupRecoveryService, assertStartupRecoverySender } = await load('startup-recovery')
  const { clearStartupRuntimeFiles, clearStartupUserFiles } = await load('startup-recovery-files')
  const { RendererStorageStore } = await load('renderer-storage-store')
  const { PreferencesStore } = await load('preferences-store')
  const { CloudCredentialService } = await load('cloud-credential-service')
  const assertRetained = async () => {
    assert.equal(await fs.readFile(sessionPath, 'utf8'), 'saved conversation')
    assert.equal(await fs.readFile(projectPath, 'utf8'), 'project source')
    const { DatabaseSync } = require('node:sqlite')
    const database = new DatabaseSync(taskPath)
    assert.equal(
      database.prepare('SELECT title FROM tasks WHERE id = ?').get('saved-task').title,
      'Retained task'
    )
    database.close()
  }
  recordPhase('verify-retained')
  if (phase !== 'runtime') {
    await assertRetained()
    await assert.rejects(fs.stat(path.join(profile, '.wework-runtime.json')), { code: 'ENOENT' })
    await assert.rejects(
      fs.stat(path.join(profile, 'node_modules/@wegent/dsh-app-wework/index.js')),
      { code: 'ENOENT' }
    )
  }
  if (phase === 'user') {
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDirectory, 'renderer-local-storage.json'), 'utf8')
      ),
      userState
    )
    assert.equal(await fs.readFile(pluginPath, 'utf8'), 'user plugin')
    assert.equal(
      JSON.parse(await fs.readFile(path.join(dataDirectory, 'app-preferences.json'), 'utf8')).theme,
      'dark'
    )
    assert.equal(
      await fs.readFile(path.join(dataDirectory, 'cloud-credentials.json'), 'utf8'),
      'synthetic credentials'
    )
    // A directory in place of the preferences file produces a real filesystem
    // error on both Windows and Unix, without mocking a recovery dependency.
    await fs.rm(path.join(dataDirectory, 'app-preferences.json'))
    await fs.mkdir(path.join(dataDirectory, 'app-preferences.json'))
  }
  if (phase === 'verify') {
    recordPhase('verify-reset')
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDirectory, 'renderer-local-storage.json'), 'utf8')
      ),
      { version: 1, entries: {} }
    )
    for (const file of [
      pluginPath,
      path.join(dataDirectory, 'app-preferences.json'),
      path.join(dataDirectory, 'cloud-credentials.json'),
      path.join(paths.codexHome, 'plugins/installed.json'),
    ]) {
      await assert.rejects(fs.stat(file), { code: 'ENOENT' })
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.plugins, {})
    assert.deepEqual(manifest.skills, { skill: {} })
    await fs.writeFile(
      path.join(root, 'evidence.json'),
      JSON.stringify({
        runtimeResetPreservesUserState: true,
        userResetPreservesTasksAndSessions: true,
        realRelaunches: 2,
        failedCleanupRetried: true,
      })
    )
    app.exit(0)
    return
  }
  recordPhase('create-splash')
  const splash = new BrowserWindow({
    show: false,
    width: 720,
    height: 600,
    webPreferences: {
      preload: path.join(dist, 'startup-splash-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  const recovery = new StartupRecoveryService({
    rendererStorage: new RendererStorageStore(dataDirectory),
    preferences: new PreferencesStore(dataDirectory),
    cloudCredentials: new CloudCredentialService(dataDirectory),
    prepareCleanup: async () => {},
    clearRuntimeFiles: () => clearStartupRuntimeFiles(dataDirectory),
    clearUserFiles: () => clearStartupUserFiles(paths),
    clearCache: () => session.defaultSession.clearCache(),
    clearAppStorage: () =>
      session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }),
    clearUserStorage: () =>
      session.defaultSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] }),
    disablePlugin: async () => {
      throw new Error('No failed plugin was selected')
    },
    log: (step, status) =>
      require('node:fs').appendFileSync(
        path.join(root, 'recovery.log'),
        step + ': ' + status + '\n'
      ),
    relaunch: () =>
      app.relaunch({
        args: [
          process.argv[1],
          process.argv[2],
          phase === 'runtime' ? 'user' : 'verify',
          ...process.argv.slice(4),
        ],
      }),
    shutdown: () => app.exit(0),
  })
  for (const [channel, mode] of [
    ['recover-workbench', 'workbench'],
    ['reset-app-state', 'app-state'],
  ]) {
    ipcMain.handle('startup-recovery:' + channel, event => {
      assertStartupRecoverySender(event.sender.id, splash.webContents.id)
      return recovery.run(mode)
    })
  }
  recordPhase('load-splash')
  await splash.loadFile(path.join(dist, 'shell/startup-splash/index.html'))
  splash.showInactive()
  await splash.webContents.executeJavaScript(
    "window.dispatchEvent(new CustomEvent('wework-startup-error', { detail: {} }))"
  )
  recordPhase('open-confirmation')
  const button = phase === 'runtime' ? 'startup-recover-button' : 'startup-reset-options-button'
  await splash.webContents.executeJavaScript(
    `document.querySelector('[data-testid="${button}"]').click()`
  )
  const description = await splash.webContents.executeJavaScript(
    "document.querySelector('#startup-confirmation-description').textContent"
  )
  assert.match(
    description,
    phase === 'runtime'
      ? /plugins.*preserved|插件.*保留/
      : /removes installed plugins|移除已安装插件/
  )
  const paintDeadline = Date.now() + 10_000
  while (
    await splash.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.splash')).opacity !== '1'"
    )
  ) {
    assert.ok(Date.now() < paintDeadline, 'The startup confirmation did not become visible')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  recordPhase('capture-confirmation')
  await fs.writeFile(
    path.join(root, phase + '-confirmation.png'),
    (await splash.webContents.capturePage()).toPNG()
  )
  recordPhase('submit-recovery')
  await splash.webContents.executeJavaScript(
    "document.querySelector('#startup-confirmation-submit').click()"
  )
  if (phase === 'user') {
    recordPhase('verify-cleanup-failure')
    const deadline = Date.now() + 10_000
    while (
      await splash.webContents.executeJavaScript(
        "document.querySelector('#startup-action-error').hidden"
      )
    ) {
      assert.ok(Date.now() < deadline, 'The cleanup failure was not shown in the splash')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await fs.writeFile(
      path.join(root, 'cleanup-failure.png'),
      (await splash.webContents.capturePage()).toPNG()
    )
    await fs.rm(path.join(dataDirectory, 'app-preferences.json'), { recursive: true })
    await put(path.join(dataDirectory, 'app-preferences.json'), '{}')
    await splash.webContents.executeJavaScript("document.querySelector('#startup-retry').click()")
  }
  recordPhase('await-relaunch')
  setTimeout(() => {
    throw new Error('The splash recovery action did not relaunch Electron')
  }, 10_000)
}
