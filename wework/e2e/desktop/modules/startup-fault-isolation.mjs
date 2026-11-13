import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectBeforeStart } from './inspect-before-start.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
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
export async function verifyStartupFaultIsolation({ appBinary, environment, resultDir, version }) {
  for (const fault of ['invalid-release', 'mismatched-host', 'missing-profile']) {
    const root = join(resultDir, 'startup-fault-isolation', fault)
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
    const evidencePath = join(resultDir, `startup-fault-${fault}.json`)
    const child = spawn(
      appBinary,
      resolveElectronLaunchArguments({
        extraArguments: ['--inspect-brk=127.0.0.1:0'],
      }),
      {
        env: {
          ...environment,
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
    )
    let output = ''
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
        accept(code)
      })
    })
    try {
      await inspectBeforeStart(child, recoveryWindowAssertion(evidencePath))
      const code = await Promise.race([
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
      assert.equal(code, 0, output)
      const result = JSON.parse(await readFile(evidencePath, 'utf8'))
      assert.equal(result.error, undefined, result.error)
      assert.equal(result.visible, true)
      assert.equal(result.retryEnabled, true)
      assert.equal(result.reopened, true)
      assert.equal(result.state.ready, false, 'Recovery must not certify a healthy release')
      assert.ok(result.state.error)
      assert.equal(await readFile(credentials, 'utf8'), saved)
      assert.equal(await readFile(descriptorPath, 'utf8'), original)
    } finally {
      await stopProcessGroup(child)
      await writeFile(join(resultDir, `startup-fault-${fault}.log`), output)
    }
  }
}

function recoveryWindowAssertion(evidencePath) {
  return `(() => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath)
    const { app, BrowserWindow } = require('electron')
    const fs = require('node:fs')
    const output = ${JSON.stringify(evidencePath)}
    const deadline = Date.now() + 10_000
    let checking = false
    let reopenRequested = false
    let companion = null
    const timer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        const window = BrowserWindow.getAllWindows().find(window =>
          window.webContents.getURL().includes('recovery=1'))
        if (!window || window.webContents.isLoading()) {
          if (Date.now() > deadline) throw new Error('The production bootstrap did not open recovery')
          return
        }
        const state = await window.webContents.executeJavaScript('window.weworkElectron.getRuntimeState()')
        const retryEnabled = await window.webContents.executeJavaScript(
          "(() => { const button = document.querySelector('[data-testid=\\\"startup-runtime-retry\\\"]'); return !button.hidden && !button.disabled && !document.querySelector('.runtime-card').hidden })()")
        if (!window.isVisible() || !retryEnabled) {
          if (Date.now() > deadline) throw new Error('Recovery was not operable')
          return
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
        fs.writeFileSync(output, JSON.stringify({visible:window.isVisible(),retryEnabled,reopened:true,state}))
        // Let Chromium close both windows before shutting down the in-process compositor.
        app.quit()
      } catch (error) {
        clearInterval(timer)
        fs.writeFileSync(output, JSON.stringify({error:error.stack}))
        app.exit(1)
      } finally { checking = false }
    }, 50)
  })()`
}
