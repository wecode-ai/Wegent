import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectBeforeStart } from './inspect-before-start.mjs'
import { stopProcessGroup } from '../process-lifecycle.mjs'

/** Exercise the delivered bootstrap, real IPC/preload, and recovery window. */
export async function verifyStartupFaultIsolation({ appBinary, environment, resultDir, version }) {
  for (const fault of ['invalid-release', 'mismatched-host', 'missing-profile']) {
    const root = join(resultDir, 'startup-fault-isolation', fault)
    const data = join(root, 'user-data')
    const releases = join(data, 'releases')
    const slot = join(releases, 'slots', 'installed-fixture')
    await mkdir(slot, { recursive: true })
    const credentials = join(data, 'cloud-credentials.json')
    const saved = 'synthetic-credential-must-remain-unchanged'
    await writeFile(credentials, saved)
    await writeFile(join(releases, 'active'), 'installed-fixture')
    const descriptor = {
      schemaVersion: 1,
      id: 'installed-fixture',
      version: fault === 'mismatched-host' ? '0.0.0' : version,
      executable: appBinary,
      resources: slot,
      runtimeRoot: join(slot, 'runtimes'),
      profileRoot: join(slot, 'profile'),
      dataSchema: 1,
      readableDataSchemas: [1],
    }
    const original = fault === 'invalid-release' ? '{broken-release' : JSON.stringify(descriptor)
    const descriptorPath = join(slot, 'release.json')
    await writeFile(descriptorPath, original)
    const evidencePath = join(root, 'result.json')
    const child = spawn(appBinary, ['--inspect-brk=127.0.0.1:0'], {
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
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    const ended = new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', code => accept(code))
    })
    try {
      await inspectBeforeStart(child, recoveryWindowAssertion(evidencePath))
      const code = await Promise.race([
        ended,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Recovery window verification timed out')),
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
      assert.equal(result.state.ready, false, 'Recovery must not certify a healthy release')
      assert.ok(result.state.error)
      assert.equal(await readFile(credentials, 'utf8'), saved)
      assert.equal(await readFile(descriptorPath, 'utf8'), original)
    } finally {
      await stopProcessGroup(child)
      await writeFile(join(root, 'app.log'), output)
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
        clearInterval(timer)
        fs.writeFileSync(output, JSON.stringify({visible:window.isVisible(),retryEnabled,state}))
        app.exit(0)
      } catch (error) {
        clearInterval(timer)
        fs.writeFileSync(output, JSON.stringify({error:error.stack}))
        app.exit(1)
      } finally { checking = false }
    }, 50)
  })()`
}
