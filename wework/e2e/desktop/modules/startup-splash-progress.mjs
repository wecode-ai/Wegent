import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { packagedResourcesRoot } from './workbench-schema-compatibility.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

// Runs the production splash, preload, IPC progress channel, and stylesheet in
// an isolated Electron process. It verifies the real renderer contract rather
// than a browser-only mock of the startup screen.
export async function verifyStartupSplashProgress({ appBinary, resultDir, electronRoot }) {
  const root = join(resultDir, 'startup-splash-progress')
  await mkdir(root, { recursive: true })
  const input = {
    root,
    electronRoot: electronRoot ?? join(packagedResourcesRoot(appBinary), 'app.asar'),
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
  const { normal, slow, timeout, failure } = evidence

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

  assert.equal(failure.failureHidden, false, 'The failure note did not appear')
  assert.equal(failure.recoveryHidden, false, 'Recovery actions did not appear for a failure')
  assertIncludesAny(
    failure.title,
    ['Wework 启动失败', 'Wework could not start'],
    'The splash did not show the failure title'
  )
}

async function runSplashProgressVerification() {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const { app, BrowserWindow } = require('electron')
  const input = JSON.parse(process.argv[2])
  app.setPath('userData', path.join(input.root, 'user-data'))
  await app.whenReady()
  const metadata = JSON.parse(
    await fs.readFile(path.join(input.electronRoot, 'package.json'), 'utf8')
  )
  const dist = path.join(input.electronRoot, path.dirname(metadata.main))
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
        failureHidden: document.querySelector('#startup-failure').hidden,
        recoveryHidden: document.querySelector('#startup-recovery').hidden,
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
    "window.dispatchEvent(new CustomEvent('wework-startup-error', { detail: {} }))"
  )
  await wait(300)
  const failure = await readState()

  await fs.writeFile(
    path.join(input.root, 'evidence.json'),
    `${JSON.stringify({ normal, slow, timeout, failure }, null, 2)}\n`
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
