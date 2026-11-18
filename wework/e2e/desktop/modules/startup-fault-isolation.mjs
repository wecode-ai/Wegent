import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectBeforeStart } from './inspect-before-start.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
import { captureStartupNativeStack } from './startup-native-stack.mjs'
import { spawnStartupGdbProbe, verifyStartupGdbContract } from './startup-gdb-probe.mjs'
import {
  assertStartupGpuEvidence,
  createStartupGpuLaunch,
  waitForStartupGpuExit,
} from './startup-gpu-evidence.mjs'
import { stopProcessGroup } from '../process-lifecycle.mjs'

export async function seedInstalledRelease({ data, appBinary, version, id = 'installed-fixture' }) {
  const releases = join(data, 'releases')
  const slot = join(releases, 'slots', id)
  await mkdir(slot, { recursive: true })
  const descriptor = {
    schemaVersion: 1,
    id,
    version,
    executable: appBinary,
    resources: slot,
    runtimeRoot: join(slot, 'runtimes'),
    profileRoot: join(slot, 'profile'),
    dataSchema: 1,
    readableDataSchemas: [1],
  }
  const descriptorPath = join(slot, 'release.json')
  const original = JSON.stringify(descriptor)
  await writeFile(descriptorPath, original)
  await writeFile(join(releases, 'active'), id)
  return { releases, descriptor, descriptorPath, original }
}

/** Exercise the delivered bootstrap, real IPC/preload, and recovery window. */
export async function verifyStartupFaultIsolation(input) {
  if (process.platform === 'linux') await verifyStartupGdbContract({ resultDir: input.resultDir })
  // Exercise each startup fault once; every launch must exit normally.
  const iterations = 1
  const ptraceScope =
    process.platform === 'linux'
      ? await readFile('/proc/sys/kernel/yama/ptrace_scope', 'utf8').then(
          value => value.trim(),
          error => ({ unavailable: error.code })
        )
      : null
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const fault of ['invalid-release', 'mismatched-host', 'missing-profile']) {
      await verifyStartupFault({ ...input, fault, iteration, iterations, ptraceScope })
    }
  }
}

async function verifyStartupFault({
  appBinary,
  environment,
  resultDir,
  version,
  fault,
  iteration,
  iterations,
  ptraceScope,
}) {
  const name = iteration === 1 ? fault : `${fault}-iteration-${iteration}`
  const root = join(resultDir, 'startup-fault-isolation', name)
  const data = join(root, 'user-data')
  const {
    releases,
    descriptor,
    descriptorPath,
    original: validDescriptor,
  } = await seedInstalledRelease({
    data,
    appBinary,
    version: fault === 'mismatched-host' ? '0.0.0' : version,
  })
  const credentials = join(data, 'cloud-credentials.json')
  const saved = 'synthetic-credential-must-remain-unchanged'
  await writeFile(credentials, saved)
  const original = fault === 'invalid-release' ? '{broken-release' : validDescriptor
  await writeFile(descriptorPath, original)
  const evidencePath = join(resultDir, `startup-fault-${name}.json`)
  const gpuLaunch = createStartupGpuLaunch(join(resultDir, `startup-fault-${name}-gpu.jsonl`))
  const startedAt = Date.now()
  const launchArguments = resolveElectronLaunchArguments({
    extraArguments: ['--inspect-brk=127.0.0.1:0', ...(gpuLaunch?.arguments ?? [])],
  })
  const launchOptions = {
    env: {
      ...environment,
      ...gpuLaunch?.env,
      WEWORK_USER_DATA_DIR: data,
      WEWORK_RELEASE_ROOT: releases,
      WEWORK_RELEASE_SUPERVISED: descriptor.id,
      WEWORK_RELEASE_RECOVERY: '',
      WEWORK_E2E_RELEASE_FAILURE_VERSION: '',
      WEWORK_E2E_CONTROL_URL: '',
      WEWORK_E2E_BACKGROUND_WINDOW: '0',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  const debuggerProbe =
    process.platform === 'linux'
      ? spawnStartupGdbProbe(appBinary, launchArguments, launchOptions)
      : null
  const child = debuggerProbe?.child ?? spawn(appBinary, launchArguments, launchOptions)
  const identity = {
    fault,
    iteration,
    iterations,
    pid: child.pid,
    debugger: Boolean(debuggerProbe),
    startedAt,
    ptraceScope,
  }
  let output = `[recovery-probe] case-start ${JSON.stringify(identity)}\n`
  child.stdout.on('data', chunk => {
    output += chunk
  })
  child.stderr.on('data', chunk => {
    output += chunk
  })
  const ended = new Promise((accept, reject) => {
    child.once('error', reject)
    // Chromium descendants can retain output pipes after the host has exited.
    child.once('exit', (code, signal) => {
      output += `\n[recovery-probe] exit ${JSON.stringify({ code, signal, at: Date.now() })}\n`
      accept({ code, signal })
    })
  })
  let primaryError
  try {
    console.info('[recovery-probe] case-start', JSON.stringify(identity))
    await inspectBeforeStart(child, recoveryWindowAssertion(evidencePath, gpuLaunch))
    const exitDeadline = Date.now() + 15_000
    const exit = await Promise.race([
      ended,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `Recovery window verification timed out (exitCode=${child.exitCode}, signalCode=${child.signalCode})`
              )
            ),
          15_000
        )
        timer.unref()
      }),
    ])
    assert.deepEqual(exit, { code: 0, signal: null }, output)
    const gpuProof = gpuLaunch ? await waitForStartupGpuExit(gpuLaunch, exitDeadline) : null
    if (debuggerProbe) await debuggerProbe.assertNormalExit(exit)
    const result = JSON.parse(await readFile(evidencePath, 'utf8'))
    console.info(
      '[recovery-probe] runtime-paths',
      JSON.stringify({ fault, iteration, ...result.profilePaths })
    )
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.visible, true)
    assert.equal(result.retryEnabled, true)
    assert.equal(result.reopened, true)
    assert.equal(result.nativeProfileIsolated, true)
    assert.equal(result.sessionProfileIsolated, true)
    assert.equal(result.state.ready, false, 'Recovery must not certify a healthy release')
    assert.ok(result.state.error)
    if (gpuLaunch) {
      assertStartupGpuEvidence(result, gpuProof, output)
      assert.deepEqual(result.gpu.started, gpuProof.started, 'The GPU startup identity changed')
      console.info(
        '[recovery-probe] gpu-exit',
        JSON.stringify({ fault, iteration, ...gpuProof, metrics: result.gpu })
      )
    }
    assert.equal(await readFile(credentials, 'utf8'), saved)
    assert.equal(await readFile(descriptorPath, 'utf8'), original)
    console.info(
      '[recovery-probe] case-pass',
      JSON.stringify({ ...identity, elapsedMs: Date.now() - startedAt })
    )
  } catch (error) {
    primaryError = error
    console.error('[recovery-probe] case-failed', JSON.stringify(identity))
    if (debuggerProbe) await debuggerProbe.captureFailure()
    else await captureStartupNativeStack(child)
    throw error
  } finally {
    try {
      if (debuggerProbe) await debuggerProbe.cleanup()
      else await stopProcessGroup(child)
    } catch (error) {
      if (!primaryError) throw error
      console.error('[recovery-probe] cleanup also failed', error)
    } finally {
      await writeFile(join(resultDir, `startup-fault-${name}.log`), output)
    }
  }
}

function recoveryWindowAssertion(evidencePath, gpuLaunch) {
  const requiredGpuLaunch = gpuLaunch
    ? {
        evidencePath: gpuLaunch.evidencePath,
        nonce: gpuLaunch.nonce,
        launcher: gpuLaunch.arguments
          .find(argument => argument.startsWith('--gpu-launcher='))
          .slice('--gpu-launcher='.length),
      }
    : null
  return `(() => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath)
    const { app, BrowserWindow } = require('electron')
    const fs = require('node:fs')
    const output = ${JSON.stringify(evidencePath)}
    // Bootstrap failures precede main's path setup; isolate native stores before ready.
    const profile = process.env.WEWORK_USER_DATA_DIR
    if (!profile) throw new Error('Recovery probe requires an isolated native profile')
    app.setPath('userData', profile)
    app.setPath('sessionData', profile)
    if (process.platform === 'linux') {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8')
      const pgid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[2])
      console.info('[startup-gdb-inferior]', JSON.stringify({pid:process.pid,ppid:process.ppid,pgid}))
    }
    const record = (event, details = {}) => console.info('[recovery-probe]', JSON.stringify({event,...details,at:Date.now()}))
    const gpuLaunch = ${JSON.stringify(requiredGpuLaunch)}
    const gpu = gpuLaunch ? {
      required:true,nativeHostPid:process.pid,initial:null,reopened:null,childProcessGone:[],quitObserved:false
    } : null
    if (gpu) record('gpu-launcher-config', {
      expected:gpuLaunch.launcher,
      actual:app.commandLine.getSwitchValue('gpu-launcher'),
      disableGpuSandbox:app.commandLine.hasSwitch('disable-gpu-sandbox')
    })
    let result = null
    const persistResult = () => {
      if (result) fs.writeFileSync(output, JSON.stringify({...result,...(gpu ? {gpu} : {})}))
    }
    for (const event of ['before-quit','will-quit','quit','window-all-closed']) {
      app.on(event, () => {
        record(event, {windows:BrowserWindow.getAllWindows().length})
        if (event === 'quit' && gpu) { gpu.quitObserved = true; persistResult() }
      })
    }
    app.on('browser-window-created', (_event, window) => {
      const id = window.id
      record('window-created', {id})
      window.once('closed', () => record('window-closed', {id}))
      window.webContents.on('render-process-gone', (_event, details) => record('render-process-gone', details))
    })
    app.on('child-process-gone', (_event, details) => {
      record('child-process-gone', details)
      if (gpu && details.type === 'GPU') {
        gpu.childProcessGone.push({...details,at:Date.now()})
        persistResult()
      }
    })
    const deadline = Date.now() + 10_000
    let pathsRecorded = false
    let profilePaths
    let checking = false
    let reopenRequested = false
    let companion = null
    const timer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        if (gpu && gpu.childProcessGone.some(event => event.reason !== 'clean-exit' || event.exitCode !== 0)) {
          throw new Error('A GPU child exited abnormally during recovery')
        }
        const window = BrowserWindow.getAllWindows().find(window =>
          window.webContents.getURL().includes('recovery=1'))
        if (!window || window.webContents.isLoading()) {
          if (Date.now() > deadline) throw new Error('The production bootstrap did not open recovery')
          return
        }
        if (!pathsRecorded) {
          pathsRecorded = true
          try {
            profilePaths = {
              nativePid:process.pid,parentPid:process.ppid,
              userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),
              configuredUserData:process.env.WEWORK_USER_DATA_DIR ?? null,
              userDataArgument:app.commandLine.getSwitchValue('user-data-dir') || null,
              home:process.env.HOME ?? null,
              xdgConfigHome:process.env.XDG_CONFIG_HOME ?? null,
              xdgCacheHome:process.env.XDG_CACHE_HOME ?? null
            }
            record('profile-paths', profilePaths)
          } catch (error) { record('profile-paths-unavailable', {error:error.name}) }
        }
        const state = await window.webContents.executeJavaScript('window.weworkElectron.getRuntimeState()')
        const retryEnabled = await window.webContents.executeJavaScript(
          "(() => { const button = document.querySelector('[data-testid=\\\"startup-runtime-retry\\\"]'); return !button.hidden && !button.disabled && !document.querySelector('.runtime-card').hidden })()")
        if (!window.isVisible() || !retryEnabled) {
          if (Date.now() > deadline) throw new Error('Recovery was not operable')
          return
        }
        if (gpu) {
          const launcher = app.commandLine.getSwitchValue('gpu-launcher')
          const disableGpuSandbox = app.commandLine.hasSwitch('disable-gpu-sandbox')
          gpu.switches = {launcher,disableGpuSandbox}
          if (launcher !== gpuLaunch.launcher || !disableGpuSandbox) {
            throw new Error('The recovery GPU launcher switches did not reach Chromium')
          }
          let started
          try {
            const text = fs.readFileSync(gpuLaunch.evidencePath, 'utf8')
            if (text.endsWith('\\n')) started = JSON.parse(text.split('\\n')[0])
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          if (!started) {
            if (Date.now() > deadline) throw new Error('The GPU launcher did not provide its startup identity')
            return
          }
          const metrics = app.getAppMetrics().filter(metric => metric.type === 'GPU')
          if (!metrics.length) {
            if (Date.now() > deadline) throw new Error('No external GPU process became available')
            return
          }
          if (metrics.length !== 1) throw new Error('Expected exactly one external GPU process')
          const {pid,type,creationTime} = metrics[0]
          if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !Number.isFinite(creationTime) || creationTime <= 0) {
            throw new Error('The external GPU process has no usable identity')
          }
          if (started.event !== 'started' || started.nonce !== gpuLaunch.nonce ||
              started.casePath !== gpuLaunch.evidencePath || started.parentPid !== process.pid ||
              started.launcherPid !== pid) {
            throw new Error('The GPU startup identity does not belong to this host and launcher')
          }
          gpu.started = started
          const metric = {pid,type,creationTime}
          if (!reopenRequested) gpu.initial = metric
          else {
            gpu.reopened = metric
            if (pid !== gpu.initial.pid || creationTime !== gpu.initial.creationTime) throw new Error('The GPU process restarted while recovery reopened')
          }
          record('gpu-process', {stage:reopenRequested ? 'reopened' : 'initial',...metric,started,switches:gpu.switches})
        }
        if (!reopenRequested) {
          const { join } = require('node:path')
          const recovery = require(join(app.getAppPath(), 'dist', 'host', 'startup-recovery-window.js'))
          // Keep a real host window alive, as happens after a late startup/install failure.
          companion = new BrowserWindow({show:false,webPreferences:{partition:'startup-recovery-companion',sandbox:true,contextIsolation:true,nodeIntegration:false}})
          await new Promise(resolve => { window.once('closed', resolve); window.close() })
          if (!recovery.focusStartupRecoveryIfActive()) throw new Error('Recovery activation was not handled')
          reopenRequested = true
          return
        }
        clearInterval(timer)
        result = {visible:window.isVisible(),retryEnabled,reopened:true,state,profilePaths,nativeProfileIsolated:app.getPath('userData')===profile,sessionProfileIsolated:app.getPath('sessionData')===profile}
        persistResult()
        record('quit-requested', {windows:BrowserWindow.getAllWindows().length})
        app.quit()
      } catch (error) {
        clearInterval(timer)
        result = {error:error.stack,profilePaths}
        persistResult()
        app.exit(1)
      } finally { checking = false }
    }, 50)
  })()`
}
