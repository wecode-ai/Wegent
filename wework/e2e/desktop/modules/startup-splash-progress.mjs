import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

export function parseStartupEvents(log) {
  return [...log.matchAll(/\[startup\]\s+\{([\s\S]*?)\}/g)].flatMap(match => {
    const body = match[1]
    const step = body.match(/\bstep:\s*'([^']+)'/)?.[1]
    const status = body.match(/\bstatus:\s*'([^']+)'/)?.[1]
    const stage = body.match(/\bstage:\s*'([^']+)'/)?.[1]
    const elapsedMs = Number(body.match(/\belapsedMs:\s*(\d+)/)?.[1])
    return step && status && Number.isFinite(elapsedMs)
      ? [{ step, status, elapsedMs, ...(stage ? { stage } : {}) }]
      : []
  })
}

export function assertStartupProgressStages(events) {
  const canonical = [
    'launch',
    'shell',
    'components',
    'runtime-files',
    'cli',
    'workspace',
    'services',
    'core-dsh',
    'renderer',
  ]
  const stages = events
    .filter(event => event.step === 'startup-progress' && event.status === 'started')
    .map(event => event.stage)
    .filter((stage, index, values) => index === 0 || stage !== values[index - 1])
  const indexes = stages.map(stage => canonical.indexOf(stage))
  assert.ok(
    indexes.every(index => index >= 0),
    `Unknown startup stage: ${JSON.stringify(stages)}`
  )
  assert.ok(
    indexes.every((value, index) => index === 0 || value > indexes[index - 1]),
    `Startup stages are out of order: ${JSON.stringify(stages)}`
  )
  for (const stage of canonical.filter(stage => stage !== 'runtime-files')) {
    assert.ok(stages.includes(stage), `Missing startup stage ${stage}: ${JSON.stringify(stages)}`)
  }
  assert.equal(stages[0], 'launch')
  assert.equal(stages.at(-1), 'renderer')
  return stages
}

export async function waitForStartupProgressEvidence({
  userDataDirectory,
  resultDir,
  name = 'startup-progress',
  afterBytes = 0,
  timeoutMs = 10_000,
}) {
  const logPath = join(userDataDirectory, 'logs', 'wework-main.log')
  const deadline = Date.now() + timeoutMs
  let log = ''
  do {
    const bytes = await readFile(logPath).catch(error => {
      if (error.code === 'ENOENT') return Buffer.alloc(0)
      throw error
    })
    log = bytes.subarray(afterBytes).toString('utf8')
    const events = parseStartupEvents(log)
    const launchIndex = events.findLastIndex(
      event => event.step === 'startup-progress' && event.stage === 'launch'
    )
    const attempt = launchIndex >= 0 ? events.slice(launchIndex) : []
    if (
      attempt.some(event => event.step === 'renderer-startup-ready') &&
      attempt.some(event => event.step === 'startup-splash-close')
    ) {
      const stages = assertStartupProgressStages(attempt)
      const evidence = { stages, events: attempt, durableLog: 'logs/wework-main.log' }
      await writeFile(
        join(resultDir, `${name}-evidence.json`),
        `${JSON.stringify(evidence, null, 2)}\n`
      )
      return evidence
    }
    await delay(50)
  } while (Date.now() < deadline)
  assert.fail(`Durable startup progress did not finish through splash close:\n${log}`)
}

// Runs the production splash, preload, IPC progress channel, and stylesheet in
// an isolated Electron process. It verifies the real renderer contract rather
// than a browser-only mock of the startup screen.
export async function verifyStartupSplashProgress({ appBinary, resultDir, electronRoot }) {
  const root = join(resultDir, 'startup-splash-progress')
  await mkdir(root, { recursive: true })
  const input = {
    root,
    electronRoot: electronRoot ?? join(dirname(appBinary), 'resources', 'app.asar'),
  }
  const scriptPath = join(root, 'verify.cjs')
  await writeFile(
    scriptPath,
    `(${runSplashProgressVerification.toString()})().catch(async error => {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const input = JSON.parse(process.argv[2]);
    await fs.writeFile(path.join(input.root, 'evidence.json'), JSON.stringify({ error: error.stack }));
    require('electron').app.exit(1);
  });`
  )
  const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(
    require('electron'),
    [scriptPath, JSON.stringify(input), ...resolveElectronLaunchArguments()],
    {
      env: environment,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }
  )

  const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  assert.equal(evidence.error, undefined, evidence.error)
  const {
    normal,
    slow,
    timeout,
    timeoutCopy,
    failure,
    failureCopy,
    copiedDiagnostics,
    missingLogs,
    firstErrorPreserved,
  } = evidence

  // The copy action must carry every startup log source, not just the UI text.
  assert.deepEqual(
    missingLogs,
    [],
    `The copied startup diagnostics missed log sources: ${missingLogs.join(', ')}`
  )
  assert.equal(
    firstErrorPreserved,
    true,
    'The copied startup diagnostics lost the first error line of a truncated log'
  )
  for (const section of [
    'Wework startup diagnostics',
    '[Startup progress]',
    '[Log directories]',
    '[Log files]',
  ]) {
    assert.ok(
      copiedDiagnostics.includes(section),
      `The copied startup diagnostics missed the ${section} section`
    )
  }

  assertIncludesAny(
    normal.stepCount,
    ['检查本地组件', 'Checking local components'],
    'The splash did not show the current startup stage'
  )
  assertIncludesAny(
    normal.activity,
    ['index.js'],
    'The splash did not show the file currently being scanned'
  )
  assert.equal(normal.activityAriaHidden, 'true', 'Activity text must not be announced repeatedly')
  assert.ok(
    Number.parseFloat(normal.activityFontSize) <= 10,
    `Activity text is too prominent: ${normal.activityFontSize}`
  )
  assert.ok(
    colorAlpha(normal.activityColor) <= 0.3,
    `Activity text is too opaque: ${normal.activityColor}`
  )
  assert.ok(
    Number(normal.progressNow) > 0 && Number(normal.progressNow) < 100,
    `The startup progress did not advance: ${normal.progressNow}`
  )

  assert.equal(slow.slowHidden, false, 'The slow-startup note did not appear')
  assert.equal(slow.timeoutHidden, true, 'The timeout reminder appeared before its stage budget')
  assert.equal(slow.recoveryHidden, true, 'Recovery actions appeared for a slow but running stage')
  assertIncludesAny(
    slow.title,
    ['启动比预期慢', 'Startup is taking longer than expected'],
    'The splash did not switch to the slow-startup title'
  )

  assert.equal(timeout.slowHidden, true, 'The slow note stayed visible with the timeout reminder')
  assert.equal(timeout.timeoutHidden, false, 'The slow-stage reminder did not appear')
  assert.equal(timeout.recoveryHidden, true, 'Recovery actions appeared for a soft timeout')
  assert.equal(
    timeout.timeoutActionsHidden,
    false,
    'The timeout state did not offer diagnostics and log recovery'
  )
  assertIncludesAny(
    timeout.timeoutTitle,
    ['首次启动可能较慢', 'First startup can take longer'],
    'The timeout state did not show the first-startup reminder'
  )
  assert.ok(
    !includesAny(timeout.title, ['启动超时', 'Startup timed out']),
    `The timeout state still shows the removed headline: ${timeout.title}`
  )
  assert.ok(
    !timeout.progressClassName.includes('is-timed-out'),
    'The progress bar still uses the removed timeout styling'
  )
  assert.equal(
    timeoutCopy.requests,
    1,
    'Copying diagnostics from the timeout state did not reach IPC'
  )
  assert.ok(
    includesAny(timeoutCopy.toastText, ['诊断信息已复制', 'Diagnostics copied']),
    `The timeout diagnostics copy did not confirm success: ${timeoutCopy.toastText}`
  )

  assert.equal(failure.failureHidden, false, 'The failure note did not appear')
  assert.equal(failure.recoveryHidden, false, 'Recovery actions did not appear for a failure')
  assert.equal(
    failure.timeoutActionsHidden,
    true,
    'The soft-timeout actions stayed visible after a hard failure'
  )
  assertIncludesAny(
    failure.title,
    ['Wework 启动失败', 'Wework could not start'],
    'The splash did not show the failure title'
  )
  assert.equal(
    failureCopy.requests,
    2,
    'Copying diagnostics from the failure state did not reach IPC'
  )
  assert.ok(
    includesAny(failureCopy.toastText, ['诊断信息已复制', 'Diagnostics copied']),
    `The failure diagnostics copy did not confirm success: ${failureCopy.toastText}`
  )
}

async function runSplashProgressVerification() {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const { pathToFileURL } = require('node:url')
  const { app, BrowserWindow, clipboard, ipcMain } = require('electron')
  const input = JSON.parse(process.argv[2])
  const diagnosticsCopyRequests = []
  const logDirectory = path.join(input.root, 'diagnostics-logs')
  const executorLogDirectory = path.join(input.root, 'executor-logs')
  await fs.mkdir(logDirectory, { recursive: true })
  await fs.mkdir(executorLogDirectory, { recursive: true })
  const logFiles = {
    main: { path: path.join(logDirectory, 'wework-main.log'), marker: 'main-process-log-marker' },
    renderer: {
      path: path.join(logDirectory, 'renderer-startup.log'),
      marker: 'renderer-startup-marker',
    },
    update: { path: path.join(logDirectory, 'app-update.log'), marker: 'app-update-marker' },
    executor: {
      path: path.join(executorLogDirectory, 'executor.log'),
      marker: 'executor-log-marker',
    },
    bootstrap: {
      path: path.join(logDirectory, 'wework-startup-bootstrap.log'),
      marker: 'bootstrap-log-marker',
    },
  }
  await Promise.all(
    Object.values(logFiles).map(file => fs.writeFile(file.path, `${file.marker}\n`))
  )
  // Overflow the included tail so the first error only survives through the
  // dedicated "first error" capture.
  const firstErrorLine = 'fatal: first startup error EACCES'
  const filler = Array.from(
    { length: 4000 },
    (_, index) => `noise ${index} ${'x'.repeat(64)}`
  ).join('\n')
  await fs.writeFile(logFiles.main.path, `${firstErrorLine}\n${filler}\n${logFiles.main.marker}\n`)
  const diagnosticsProgress = () => ({
    index: 2,
    total: 9,
    completedWeight: 10,
    startedAt: Date.now() - 5_000,
    stage: {
      id: 'components',
      label: { en: 'Checking local components', zh: '检查本地组件' },
      detail: { en: 'Scanning local component files…', zh: '正在扫描本地组件文件…' },
      weight: 15,
      expectedMs: 2_500,
      timeoutMs: 60_000,
    },
  })
  let dist = ''
  ipcMain.handle('startup-diagnostics:copy', async () => {
    diagnosticsCopyRequests.push(Date.now())
    const { buildStartupDiagnostics } = await import(
      pathToFileURL(path.join(dist, 'host', 'startup-diagnostics.js')).href
    )
    const text = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0-e2e',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      logDirectories: [logDirectory, executorLogDirectory],
      extraLogPaths: [logFiles.bootstrap.path],
      progress: { current: diagnosticsProgress(), history: [diagnosticsProgress()] },
      failure: { message: 'simulated startup failure' },
      runtimeError: null,
      runtimeState: null,
    })
    clipboard.writeText(text)
    return { ok: true, characters: text.length }
  })
  ipcMain.handle('startup-diagnostics:open-logs', () => ({ ok: true }))
  app.setPath('userData', path.join(input.root, 'user-data'))
  await app.whenReady()
  const metadata = JSON.parse(
    await fs.readFile(path.join(input.electronRoot, 'package.json'), 'utf8')
  )
  dist = path.join(input.electronRoot, path.dirname(metadata.main))
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
  await splash.loadFile(path.join(dist, 'shell/startup-splash/index.html'))
  splash.showInactive()

  const send = update => splash.webContents.send('startup-progress:update', update)
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const readState = () =>
    splash.webContents.executeJavaScript(`(() => {
      const activity = document.querySelector('#splash-activity')
      const activityStyle = getComputedStyle(activity)
      return {
        title: document.querySelector('#splash-title').textContent,
        stepCount: document.querySelector('#splash-step-count').textContent,
        activity: activity.textContent,
        activityAriaHidden: activity.getAttribute('aria-hidden'),
        activityColor: activityStyle.color,
        activityFontSize: activityStyle.fontSize,
        slowHidden: document.querySelector('#startup-slow').hidden,
        timeoutHidden: document.querySelector('#startup-timeout').hidden,
        timeoutTitle: document.querySelector('#startup-timeout-title').textContent,
        timeoutActionsHidden: document.querySelector('#startup-timeout-actions').hidden,
        failureHidden: document.querySelector('#startup-failure').hidden,
        recoveryHidden: document.querySelector('#startup-recovery').hidden,
        toastText: document.querySelector('#startup-toast').textContent,
        progressClassName: document.querySelector('#splash-progress').className,
        progressNow: document.querySelector('#splash-progress').getAttribute('aria-valuenow'),
      }
    })()`)

  const stage = {
    id: 'components',
    label: { en: 'Checking local components', zh: '检查本地组件' },
    detail: {
      en: 'Scanning local component files…',
      zh: '正在扫描本地组件文件…',
    },
    weight: 15,
    expectedMs: 2_500,
    timeoutMs: 60_000,
  }
  const update = (elapsedMs, activity) => ({
    index: 2,
    total: 9,
    completedWeight: 10,
    startedAt: Date.now() - elapsedMs,
    stage,
    ...(activity ? { activity } : {}),
  })

  send(
    update(5_000, {
      kind: 'scan',
      path: 'plugins/@wegent/ai-fleet-defense/dist/client/index.js',
    })
  )
  await wait(300)
  const normal = await readState()

  send(update(31_000))
  await wait(300)
  const slow = await readState()

  send(update(61_000))
  await wait(300)
  const timeout = await readState()
  await splash.webContents.executeJavaScript(
    'document.querySelector(\'[data-testid="startup-timeout-copy-button"]\').click()'
  )
  await wait(300)
  const timeoutCopy = { requests: diagnosticsCopyRequests.length, ...(await readState()) }

  await splash.webContents.executeJavaScript(
    "window.dispatchEvent(new CustomEvent('wework-startup-error', { detail: {} }))"
  )
  await wait(300)
  const failure = await readState()
  await splash.webContents.executeJavaScript(
    'document.querySelector(\'[data-testid="startup-copy-diagnostics-button"]\').click()'
  )
  await wait(300)
  const failureCopy = { requests: diagnosticsCopyRequests.length, ...(await readState()) }
  const copiedDiagnostics = clipboard.readText()
  const missingLogs = Object.entries(logFiles)
    .filter(([, file]) => !copiedDiagnostics.includes(file.marker))
    .map(([name]) => name)
  const firstErrorPreserved = copiedDiagnostics.includes(firstErrorLine)

  await fs.writeFile(
    path.join(input.root, 'evidence.json'),
    `${JSON.stringify(
      {
        normal,
        slow,
        timeout,
        timeoutCopy,
        failure,
        failureCopy,
        copiedDiagnostics,
        missingLogs,
        firstErrorPreserved,
      },
      null,
      2
    )}\n`
  )
  app.exit(0)
}

function includesAny(value, candidates) {
  return candidates.some(candidate => String(value).includes(candidate))
}

function assertIncludesAny(value, candidates, message) {
  assert.ok(includesAny(value, candidates), `${message}: ${value}`)
}

function colorAlpha(color) {
  const match = /rgba?\([^)]*?,\s*([0-9.]+)\)/.exec(String(color))
  return match ? Number(match[1]) : 1
}
