import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const { app, BrowserWindow } = createRequire(process.execPath)('electron')
const output = process.env.WEWORK_E2E_GPU_SMOKE_RESULT
assert.equal(process.platform, 'linux')
assert.ok(output)
const profile = join(process.env.WEWORK_E2E_GPU_SMOKE_ROOT, 'profile')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const result = {
  profilePaths: { nativePid: process.pid },
  switches: {
    gpuLauncher: app.commandLine.getSwitchValue('gpu-launcher'),
    disableGpuSandbox: app.commandLine.hasSwitch('disable-gpu-sandbox'),
  },
  gpu: {
    required: true,
    nativeHostPid: process.pid,
    initial: null,
    reopened: null,
    childProcessGone: [],
    quitObserved: false,
  },
  gpuParents: {},
  stage: 'module-loaded',
}
const persist = () => writeFileSync(output, JSON.stringify(result))
const markStage = stage => {
  result.stage = stage
  persist()
}
markStage('before-app-ready')
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return
  result.gpu.childProcessGone.push(details)
  persist()
})
app.on('quit', () => {
  result.gpu.quitObserved = true
  persist()
})

async function recordGpu(stage, deadline) {
  while (Date.now() < deadline) {
    const metrics = app.getAppMetrics().filter(metric => metric.type === 'GPU')
    if (metrics.length) {
      assert.equal(metrics.length, 1, 'Expected one fixture GPU')
      const { pid, type, creationTime } = metrics[0]
      assert.ok(Number.isFinite(creationTime) && creationTime > 0)
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const parentPid = Number(
        stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)[1]
      )
      const parentArguments = readFileSync(`/proc/${parentPid}/cmdline`, 'utf8').split('\0')
      result.gpu[stage] = { pid, type, creationTime }
      result.gpuParents[stage] = {
        pid: parentPid,
        isZygote: parentArguments.includes('--type=zygote'),
      }
      persist()
      return
    }
    await setTimeout(Math.min(25, Math.max(0, deadline - Date.now())))
  }
  throw new Error('No fixture GPU became available within the startup deadline')
}

app
  .whenReady()
  .then(async () => {
    assert.equal(result.switches.gpuLauncher, process.env.WEWORK_E2E_GPU_LAUNCHER_VALUE)
    const deadline = Date.now() + 10_000
    markStage('before-first-window')
    const original = new BrowserWindow({ show: false })
    markStage('before-first-navigation')
    await original.loadURL('data:text/html,<title>GPU launch contract</title>')
    markStage('before-initial-gpu')
    await recordGpu('initial', deadline)
    const companion = new BrowserWindow({ show: false })
    original.close()
    const reopened = new BrowserWindow({ show: false })
    await reopened.loadURL('data:text/html,<title>GPU reopen contract</title>')
    await recordGpu('reopened', deadline)
    assert.equal(companion.isDestroyed(), false)
    app.quit()
  })
  .catch(error => {
    result.error = error.stack
    persist()
    console.error('[startup-gpu-contract] fixture failed', error)
    app.exit(1)
  })
