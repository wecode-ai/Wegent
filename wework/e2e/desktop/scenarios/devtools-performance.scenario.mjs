import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createDevtoolsClient,
  startPerformanceRecording,
  stopPerformanceRecording,
  collectProtocolEvents,
} from '../../../scripts/ai-verify-devtools.mjs'

const FIXTURE_PATH = '/devtools-performance-fixture'

async function waitForProtocolEvent(client, target, method, after, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = await collectProtocolEvents(client, target, after)
    assert.equal(page.lost, 0)
    const match = page.events.find(event => event.method === method)
    if (match) return match
    after = page.cursor
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Missing CDP event: ${method}`)
}

/** User story: an AI records a real interaction, diagnoses it and resumes a paused renderer. */
export async function verifyDevtoolsPerformance(
  directory,
  fixtureUrl,
  timeoutMs = 10_000,
  reproduce = async () => {}
) {
  const client = await createDevtoolsClient(directory, timeoutMs)
  const targets = await client({ action: 'targets' })
  const main = targets.find(
    target =>
      target.type === 'window' &&
      !target.url.startsWith('devtools:') &&
      !target.url.includes('startup-splash')
  )
  assert.ok(main, 'The real main renderer must be discoverable')
  const target = main.id
  const command = (method, params, sessionId) =>
    client({ action: 'command', target, method, params, sessionId })
  const output = join(directory, 'devtools-performance-report.json')
  let pendingPause
  try {
    await command('Runtime.enable')
    await command('Debugger.enable')
    await startPerformanceRecording(client, directory, target)
    await reproduce()
    await assert.rejects(
      startPerformanceRecording(client, directory, target),
      /recording already exists/
    )
    const fixture = new URL('../fixtures/devtools-performance.js', import.meta.url)
    const source = await readFile(fixture, 'utf8')
    const map = {
      version: 3,
      sources: [fixture.href],
      names: [],
      mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA;AACA',
      sourcesContent: [source],
    }
    const expression = `${source}\n//# sourceURL=${fixture.href}?generated\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
    const evaluated = await command('Runtime.evaluate', { expression })
    assert.equal(evaluated.exceptionDetails, undefined)
    await command('Runtime.evaluate', {
      expression: `fetch(${JSON.stringify(fixtureUrl)}).then(response => response.text())`,
      awaitPromise: true,
      returnByValue: true,
    })
    const beforeException = (await collectProtocolEvents(client, target)).cursor
    await command('Runtime.evaluate', {
      expression: 'setTimeout(() => { throw new Error("DEVTOOLS_DIAGNOSTIC_EXCEPTION") }, 0)',
    })
    await waitForProtocolEvent(
      client,
      target,
      'Runtime.exceptionThrown',
      beforeException,
      timeoutMs
    )
    // A protocol error must not invalidate the persistent session.
    await assert.rejects(command('UnknownDomain.unknownCommand'))
    assert.ok((await command('Performance.getMetrics')).metrics.length)
    const recorded = await stopPerformanceRecording(client, directory, target, output)
    assert.equal(recorded.lostEvents, 0)
    const report = JSON.parse(await readFile(output, 'utf8'))
    const hot = report.cpu.find(entry => entry.function === 'diagnosticHotFunction')
    assert.ok(hot?.selfMs > 0, 'The actual CPU profile must identify the busy function')
    assert.equal(hot.location.mapped, true, JSON.stringify(report.evidence))
    assert.equal(hot.location.source, fileURLToPath(fixture))
    for (const entry of report.cpu.filter(entry =>
      entry.location.source?.includes('/wework/src/')
    )) {
      assert.ok(
        (await readFile(entry.location.source, 'utf8')).length,
        'Mapped application source must exist'
      )
    }
    assert.ok(
      report.trace.longTasks.some(task => task.durationMs >= 50),
      'The trace must expose the long task'
    )
    assert.ok(
      report.network.requests.some(request => request.url === fixtureUrl && request.status === 200)
    )
    assert.ok(JSON.stringify(report.console).includes('DEVTOOLS_PERFORMANCE_FIXTURE'))
    assert.ok(JSON.stringify(report.console).includes('DEVTOOLS_DIAGNOSTIC_EXCEPTION'))
    const request = report.network.requests.find(request => request.url === fixtureUrl)
    const body = await command('Network.getResponseBody', { requestId: request.requestId })
    assert.ok(
      (body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body).includes(
        'devtools'
      )
    )
    const object = report.console
      .filter(event =>
        event.params.stackTrace?.callFrames.some(frame => frame.url === `${fixture.href}?generated`)
      )
      .flatMap(event => event.params.args ?? [])
      .find(arg => arg.objectId)
    assert.ok(object, 'Console remote objects must remain inspectable')
    const properties = await command('Runtime.getProperties', {
      objectId: object.objectId,
      ownProperties: true,
    })
    assert.ok(
      properties.result.some(
        property => property.name === 'marker' && property.value.value === 'DEVTOOLS_REMOTE_OBJECT'
      )
    )
    assert.equal(report.evidence.traceDataLoss, false)
    const blockedOutput = join(directory, 'devtools-blocked-output')
    await writeFile(blockedOutput, 'This file cannot contain a report directory')
    await startPerformanceRecording(client, directory, target)
    await assert.rejects(
      stopPerformanceRecording(client, directory, target, join(blockedOutput, 'report.json')),
      error => ['EEXIST', 'ENOTDIR'].includes(error.code)
    )
    await startPerformanceRecording(client, directory, target)
    await stopPerformanceRecording(
      client,
      directory,
      target,
      join(directory, 'devtools-recovered-report.json')
    )
    // Read page DOM, attach a worker child session and use a domain absent from the recording workflow.
    assert.ok((await command('DOM.getDocument')).root.nodeId)
    await command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    const beforeWorker = (await collectProtocolEvents(client, target)).cursor
    await command('Runtime.evaluate', {
      expression:
        'globalThis.__devtoolsWorker = new Worker(URL.createObjectURL(new Blob(["onmessage = () => postMessage(42)"], {type:"text/javascript"})))',
    })
    const worker = await waitForProtocolEvent(
      client,
      target,
      'Target.attachedToTarget',
      beforeWorker,
      timeoutMs
    )
    const workerResult = await command(
      'Runtime.evaluate',
      { expression: '6 * 7', returnByValue: true },
      worker.params.sessionId
    )
    assert.equal(workerResult.result.value, 42)
    await command('Runtime.evaluate', {
      expression: 'globalThis.__devtoolsWorker.terminate(); delete globalThis.__devtoolsWorker',
    })
    await command('Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    const beforePause = (await collectProtocolEvents(client, target)).cursor
    pendingPause = command('Runtime.evaluate', { expression: 'debugger; 42', returnByValue: true })
    // Attach a rejection handler immediately; the assertion below still sees failures.
    pendingPause.catch(() => {})
    await waitForProtocolEvent(client, target, 'Debugger.paused', beforePause, timeoutMs)
    await command('Debugger.resume')
    assert.equal((await pendingPause).result.value, 42)
    await startPerformanceRecording(client, directory, target)
    await client({ action: 'detach', target })
    await assert.rejects(readFile(join(directory, `performance-${target}.json`)), {
      code: 'ENOENT',
    })
    assert.equal(
      (await client({ action: 'targets' })).find(item => item.id === target).attached,
      false
    )
    // Explicit reattachment after detach must work.
    assert.equal(
      (await command('Runtime.evaluate', { expression: '21 * 2', returnByValue: true })).result
        .value,
      42
    )
    await startPerformanceRecording(client, directory, target)
    await stopPerformanceRecording(
      client,
      directory,
      target,
      join(directory, 'devtools-reattached-report.json')
    )
    return { devtoolsPerformance: true, report: output }
  } finally {
    await command('Debugger.resume').catch(() => {})
    await pendingPause?.catch(() => {})
    await client({ action: 'detach', target })
  }
}

export function createDesktopScenario({ resultDir, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'GET' || url.pathname !== FIXTURE_PATH) return false
      response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
      response.end('devtools network evidence')
      return true
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="settings-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      return verifyDevtoolsPerformance(
        resultDir,
        control.url + FIXTURE_PATH,
        uiTimeoutMs,
        async () => {
          await control.command('click', '[data-testid="settings-button"]')
          await control.command('waitFor', '[data-testid="settings-menu-button"]')
          await control.command('press', 'body', { key: 'Escape' })
        }
      )
    },
  }
}
