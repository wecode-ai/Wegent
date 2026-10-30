import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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

async function inspectSplash(control) {
  return JSON.parse(await control.command('inspectStartupSplash', 'body'))
}

async function waitForSplash(control, predicate, description) {
  const deadline = Date.now() + 10_000
  let state
  do {
    state = await inspectSplash(control)
    if (predicate(state)) return state
    await delay(50)
  } while (Date.now() < deadline)
  assert.fail(`${description}: ${JSON.stringify(state)}`)
}

async function waitForHandlerLog(logPath, afterBytes, step, status) {
  const deadline = Date.now() + 10_000
  do {
    const log = (await readFile(logPath)).subarray(afterBytes).toString('utf8')
    const event = parseStartupEvents(log).find(
      event => event.step === step && event.status === status
    )
    if (event) return event
    await delay(50)
  } while (Date.now() < deadline)
  assert.fail(`The real ${step} handler did not log ${status}`)
}

async function clickSplash(control, testId) {
  await control.command('clickStartupSplash', 'body', { value: testId })
}

async function copyDiagnostics(control, testId, logPath) {
  const afterBytes = (await readFile(logPath)).length
  await clickSplash(control, testId)
  await waitForHandlerLog(logPath, afterBytes, 'startup-diagnostics-copy', 'completed')
  await waitForSplash(
    control,
    state => /诊断信息已复制|Diagnostics copied/.test(state.toastText),
    'Copying real startup diagnostics did not confirm success'
  )
  const diagnostics = await control.command('getClipboardText', 'body')
  for (const section of [
    'Wework startup diagnostics',
    '[Startup result]',
    '[Startup progress]',
    '[Failure]',
    '[Log directories]',
    '[Log files]',
    'wework-main.log',
    'executor.log',
    'dsh-core-runtime.log',
  ]) {
    assert.ok(diagnostics.includes(section), `Copied diagnostics omitted ${section}`)
  }
  assert.match(diagnostics, /renderer-startup-ready/)
  return diagnostics
}

async function verifyOpenLogs(control, testId, logPath, blockedDirectory) {
  const beforeSuccess = (await readFile(logPath)).length
  await clickSplash(control, testId)
  const completed = await waitForHandlerLog(
    logPath,
    beforeSuccess,
    'startup-diagnostics-open-logs',
    'completed'
  )
  await control.command('setStartupLogPath', 'body', { value: blockedDirectory })
  try {
    await rm(blockedDirectory, { recursive: true })
    await writeFile(blockedDirectory, 'A real file cannot be opened as the log directory.\n')
    const beforeFailure = (await readFile(logPath)).length
    await clickSplash(control, testId)
    const failed = await waitForHandlerLog(
      logPath,
      beforeFailure,
      'startup-diagnostics-open-logs',
      'failed'
    )
    const snapshot = await waitForSplash(
      control,
      state => /无法打开日志目录|Could not open the log folder/.test(state.toastText),
      'A real log-directory error did not reach the splash'
    )
    return { completed, failed, toastText: snapshot.toastText }
  } finally {
    await control.command('setStartupLogPath', 'body')
    await rm(blockedDirectory, { force: true })
    await mkdir(blockedDirectory)
  }
}

// Uses the running CI application, its main handlers, its native splash, and
// its durable logs. The test changes timer budgets, never startup state.
export async function verifyStartupSplashProgress({
  control,
  resultDir,
  restartDesktopApp,
  userDataDirectory,
}) {
  assert.ok(restartDesktopApp, 'Startup diagnostics require the desktop restart hook')
  const root = join(resultDir, 'startup-splash-progress')
  const logPath = join(userDataDirectory, 'logs', 'wework-main.log')
  await mkdir(root, { recursive: true })
  const blockedDirectory = join(root, 'log-directory-is-a-file')
  await mkdir(blockedDirectory)
  await restartDesktopApp({
    appEnvironmentOverrides: {
      WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '60000',
      WEWORK_E2E_STARTUP_SLOW_AFTER_MS: '500',
      WEWORK_E2E_STARTUP_STAGE_TIMEOUT_MS: '5000',
    },
  })
  const slow = await waitForSplash(
    control,
    state => state.progress?.stage.id === 'renderer' && !state.slowHidden && state.timeoutHidden,
    'The real startup stage did not show its slow state before its timeout budget'
  )
  assert.equal(slow.failure, null)
  assert.equal(slow.recoveryHidden, true)
  assert.match(slow.title, /启动比预期慢|Startup is taking longer than expected/)
  assert.equal(slow.activityAriaHidden, 'true')
  assert.ok(Number.parseFloat(slow.activityFontSize) >= 11)
  assert.ok(Number(slow.progressNow) > 0 && Number(slow.progressNow) < 100)
  const timeout = await waitForSplash(
    control,
    state => !state.timeoutHidden && !state.timeoutActionsHidden,
    'The real startup timer did not show diagnostics actions'
  )
  assert.equal(timeout.failure, null)
  assert.equal(timeout.recoveryHidden, true)
  assert.match(timeout.timeoutTitle, /首次启动可能较慢|First startup can take longer/)
  const timeoutDiagnostics = await copyDiagnostics(control, 'startup-timeout-copy-button', logPath)
  assert.match(timeoutDiagnostics, /\[Startup result\]\nStartup is slow: stage renderer/)
  assert.match(timeoutDiagnostics, /\(no startup failure recorded\)/)
  const timeoutOpenLogs = await verifyOpenLogs(
    control,
    'startup-timeout-open-logs-button',
    logPath,
    blockedDirectory
  )

  // A React exception crosses the production error boundary and failure route.
  await control.command('crashRenderer', 'body')
  const failure = await waitForSplash(
    control,
    state => !state.failureHidden && !state.recoveryHidden,
    'The renderer error did not become a real startup failure'
  )
  assert.equal(failure.timeoutHidden, true)
  assert.equal(failure.failure?.message, 'Desktop E2E intentional renderer crash')
  assert.equal(failure.failure?.source, 'renderer_mount')
  assert.equal(failure.failure?.stage, 'renderer')
  assert.match(failure.failure?.stack ?? '', /Desktop E2E intentional renderer crash/)
  const failureDiagnostics = await copyDiagnostics(
    control,
    'startup-copy-diagnostics-button',
    logPath
  )
  assert.match(failureDiagnostics, /Desktop E2E intentional renderer crash/)
  assert.match(
    failureDiagnostics,
    /\[Startup result\]\nStartup failed: Desktop E2E intentional renderer crash/
  )
  assert.doesNotMatch(failureDiagnostics, /\[Startup result\]\nStartup is in progress/)
  assert.match(failureDiagnostics, /Source: renderer_mount/)
  assert.match(failureDiagnostics, /Stage: renderer/)
  assert.match(failureDiagnostics, /renderer-startup\.log/)
  assert.match(failureDiagnostics, /\[renderer:error\]/)
  const failureOpenLogs = await verifyOpenLogs(
    control,
    'startup-open-logs-button',
    logPath,
    blockedDirectory
  )
  await writeFile(join(root, 'timeout-diagnostics.txt'), timeoutDiagnostics)
  await writeFile(join(root, 'failure-diagnostics.txt'), failureDiagnostics)
  await writeFile(
    join(root, 'evidence.json'),
    `${JSON.stringify({ slow, timeout, timeoutOpenLogs, failure, failureOpenLogs }, null, 2)}\n`
  )
}
