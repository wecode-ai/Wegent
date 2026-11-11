// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/dsh-owner-capture.scenario.mjs'

// Protocol coverage only; the registered desktop checkpoint retains real Electron and DSH.
async function fixture({
  cancelledInstallation = false,
  rejectConfiguration = false,
  rejectSnapshot = false,
  replaceContentsOnRestore = false,
} = {}) {
  const resultDir = await mkdtemp(join(tmpdir(), 'dsh-owner-capture-protocol-'))
  onTestFinished(() => rm(resultDir, { recursive: true, force: true }))
  const creation = Promise.withResolvers()
  const events = []
  const snapshots = []
  const id = 'capture-owner'
  let creating = false
  let approved = false
  let presentation = 'window'
  let started = false
  let visible = false
  let requestedVisible = true
  let visibilityPending = false
  let ready = false
  const response = (result, error) =>
    JSON.stringify({
      status: error ? 400 : 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(error ? { ok: false, error } : { ok: true, result }),
    })
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'getLocationOrigin') return 'http://127.0.0.1:9000'
      if (action === 'workbenchApp') {
        const request = JSON.parse(options.value)
        if (request.action === 'snapshot') {
          assert.equal(request.id, id)
          assert.equal(started, true)
          if (rejectSnapshot) throw new Error('Host snapshot unavailable')
          if (snapshots.length === 3)
            assert.ok(
              events.includes('capture:invalid'),
              'Loaded extended DSH must not wait for a lightweight SDK'
            )
          const starting = snapshots.length < 3
          // The owner tab remains open; its native surface follows selection asynchronously.
          if (starting) visible = snapshots.length !== 1
          else if (visibilityPending) visibilityPending = false
          else visible = requestedVisible
          const state = {
            running: true,
            visible,
            url: snapshots.length === 0 ? 'about:blank' : 'http://127.0.0.1:9001/',
            contentsId: replaceContentsOnRestore && visible && !starting ? 8 : 7,
            presentation,
            sdkAvailable: false,
          }
          ready ||= state.url.startsWith('http:') && state.visible
          snapshots.push(state)
          return JSON.stringify(state)
        }
        assert.equal(request.action, 'installation')
        assert.equal(creating, true, 'Creation must remain pending while confirmation is handled')
        if (request.choice === undefined) {
          events.push('confirmation:ready')
          return JSON.stringify({ visible: true, ready: true })
        }
        assert.equal(request.choice, 'accept')
        events.push('confirmation:accepted')
        approved = true
        creating = false
        creation.resolve(response(cancelledInstallation ? null : { id }))
        events.push('creation:resolved')
        return JSON.stringify({ clicked: true })
      }
      if (action === 'fetchLocalRuntime') {
        const request = JSON.parse(options.value)
        assert.equal(Object.hasOwn(request, 'timeoutMs'), false, 'Keep the Runtime default timeout')
        assert.equal(
          Object.hasOwn(options, 'timeoutMs'),
          false,
          'Keep the controller default timeout'
        )
        const { capability, params } = JSON.parse(request.body)
        if (capability === 'smartApps.createDirectory') {
          assert.equal(params.parentPath, resultDir)
          assert.equal(params.template, 'web')
          assert.equal(Object.hasOwn(params, 'flavor'), false, 'Keep extended DSH coverage')
          creating = true
          events.push('creation:pending')
          return creation.promise
        }
        assert.equal(approved, true, 'No installed operation may precede native confirmation')
        if (capability === 'smartApps.configure') {
          assert.deepEqual(params, { installationId: id, presentation: 'tab' })
          assert.equal(started, false)
          events.push('configure:tab')
          if (rejectConfiguration) return response(null, { message: 'Tab configuration failed' })
          presentation = params.presentation
          return response({ id, presentation })
        }
        if (capability === 'smartApps.stop' || capability === 'smartApps.delete') {
          assert.equal(params.installationId, id)
          events.push(capability === 'smartApps.stop' ? 'stop' : 'delete')
          return response(null)
        }
        assert.equal(started, true, 'Capture requires the launched workbench')
        assert.equal(ready, true, 'Host HTTP page must be loaded and visible before diagnostics')
        if (capability.startsWith('dshCapture.'))
          assert.equal(new URL(request.url).origin, 'http://127.0.0.1:9001')
        if (capability === 'deviceDiagnostics.microphone') {
          if (params.inputDeviceKind === 'default')
            return response(null, { code: 'invalid_params' })
          return response({
            schemaVersion: 1,
            platform: process.platform,
            checkedAt: new Date().toISOString(),
            inputDeviceKind: params.inputDeviceKind ?? 'unknown',
            status: process.platform === 'darwin' ? 'unknown' : 'unsupported',
            code: 'MICROPHONE_DIAGNOSTICS_UNSUPPORTED',
            checks: {
              lidState: 'not-present',
              appSignature: { hardenedRuntime: false, audioInputEntitlement: false },
              audioHelperSignature: { hardenedRuntime: false, audioInputEntitlement: false },
              usageDescriptionPresent: false,
              permission: 'not-determined',
            },
            issues: [],
          })
        }
        if (capability === 'dshCapture.capabilities') return response({ available: visible })
        assert.equal(capability, 'dshCapture.ownerRect')
        if (params.x < 0) {
          events.push('capture:invalid')
          return response(null, { code: 'invalid_params' })
        }
        if (!visible) {
          events.push('capture:hidden')
          return response(null, { code: 'owner_view_hidden' })
        }
        events.push('capture:visible')
        return response({ dataUrl: 'data:image/png;base64,protocol-fixture' })
      }
      if (action === 'getAttribute') {
        if (options.value === 'aria-checked') return 'true'
        if (options.value === 'data-testid') return 'workspace-tab-select-initial'
        assert.equal(options.value, 'data-workspace-tab-id')
        return `harness-${id}`
      }
      if (action === 'clickWhenEnabled') {
        assert.equal(selector, `[data-testid="harness-app-start-${id}"]`)
        assert.equal(presentation, 'tab', 'The capture checkpoint requires tab presentation')
        started = true
        events.push('start:tab')
        return ''
      }
      if (action === 'click') {
        assert.ok(selector.includes('workspace-tab-select-'))
        requestedVisible = selector.includes(`harness-${id}`)
        visibilityPending = true
        return ''
      }
      if (action === 'waitFor' && selector.includes('app-iframe')) {
        assert.equal(ready, true, 'Wait for the Host page before reading its layout placeholder')
        assert.equal(Object.hasOwn(options, 'timeoutMs'), false)
      } else assert.ok(['navigate', 'waitFor', 'select'].includes(action), action)
      return ''
    },
  }
  return {
    events,
    snapshots,
    resultDir,
    run: () => createDesktopScenario({ resultDir, uiTimeoutMs: 1000 }).verify(control),
  }
}

test('captures extended DSH without a lightweight SDK after native installation and tab readiness', async () => {
  const { run, events, snapshots, resultDir } = await fixture()
  await run()
  assert.deepEqual(events, [
    'creation:pending',
    'confirmation:ready',
    'confirmation:accepted',
    'creation:resolved',
    'configure:tab',
    'start:tab',
    'capture:visible',
    'capture:invalid',
    'capture:hidden',
    'capture:visible',
    'stop',
    'delete',
  ])
  assert.deepEqual(
    snapshots.map(state => [state.url, state.sdkAvailable, state.visible]),
    [
      ['about:blank', false, true],
      ['http://127.0.0.1:9001/', false, false],
      ['http://127.0.0.1:9001/', false, true],
      ['http://127.0.0.1:9001/', false, true],
      ['http://127.0.0.1:9001/', false, false],
      ['http://127.0.0.1:9001/', false, false],
      ['http://127.0.0.1:9001/', false, true],
    ]
  )
  const result = JSON.parse(await readFile(join(resultDir, 'dsh-owner-capture.json'), 'utf8'))
  assert.equal(result.captured, true)
  assert.equal(result.invalidRejected, true)
  assert.equal(result.hiddenRejected, true)
  assert.equal(result.captureRecovered, true)
  assert.ok(result.microphoneDiagnostics.core)
  assert.ok(result.microphoneDiagnostics.workbench)
})

test('stops before configuration and launch when confirmation produces no installation', async () => {
  const { run, events } = await fixture({ cancelledInstallation: true })
  await assert.rejects(run(), /Native installation confirmation did not produce a workbench/)
  assert.deepEqual(events, [
    'creation:pending',
    'confirmation:ready',
    'confirmation:accepted',
    'creation:resolved',
  ])
})

test('fails tab configuration without launching a window and still removes the fixture installation', async () => {
  const { run, events } = await fixture({ rejectConfiguration: true })
  await assert.rejects(run(), /Tab configuration failed/)
  assert.deepEqual(events.slice(-3), ['configure:tab', 'stop', 'delete'])
  assert.equal(events.includes('start:tab'), false)
  assert.equal(
    events.some(event => event.startsWith('capture:')),
    false
  )
})

test('cleans up when the Host page cannot be inspected', async () => {
  const { run, events } = await fixture({ rejectSnapshot: true })
  await assert.rejects(run(), /Host snapshot unavailable/)
  assert.deepEqual(events.slice(-3), ['start:tab', 'stop', 'delete'])
})

test('rejects capture recovery from a replacement page and still cleans up', async () => {
  const { run, events } = await fixture({ replaceContentsOnRestore: true })
  await assert.rejects(run(), /Host-owned workbench contents changed/)
  assert.deepEqual(events.slice(-2), ['stop', 'delete'])
  assert.equal(events.filter(event => event === 'capture:visible').length, 1)
})
