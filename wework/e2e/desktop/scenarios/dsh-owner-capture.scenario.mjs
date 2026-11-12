import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { confirmHarnessInstallation } from '../modules/harness-app-fixture.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'

const HOST_INVOKE_PATH = '/wework/electron-host/v1/invoke'
const MODEL_LABEL = 'Desktop E2E Chat'

async function postInvoke(control, origin, capability, params) {
  const endpoint = `${origin}${HOST_INVOKE_PATH}`
  const response = await fetchLocalRuntime(control, endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
  })
  return { response, payload: await response.json() }
}

async function invoke(control, origin, capability, params = {}) {
  const { response, payload } = await postInvoke(control, origin, capability, params)
  assert.equal(
    response.ok,
    true,
    `${capability} returned ${payload.error?.message ?? response.status}`
  )
  assert.equal(payload.ok, true, `${capability} failed: ${payload.error?.message}`)
  return payload.result
}

async function invokeFailure(control, origin, capability, params = {}) {
  const { response, payload } = await postInvoke(control, origin, capability, params)
  assert.equal(response.ok, false, `${capability} unexpectedly returned HTTP success`)
  assert.equal(payload.ok, false, `${capability} unexpectedly succeeded`)
  return payload.error
}

async function enableExperimentalFeatures(control) {
  await control.command('navigate', 'body', { value: '/settings/general' })
  const selector = '[data-testid="general-experimental-features-toggle"]'
  await control.command('waitFor', selector, { enabled: true, stableMs: 300 })
  const enabled = await control.command('getAttribute', selector, { value: 'aria-checked' })
  if (enabled !== 'true') await control.command('click', selector)
  await control.command('waitFor', `${selector}[aria-checked="true"]`, { stableMs: 300 })
}

async function waitForOwnerVisibility(readOwner, initial, visible, message, timeoutMs) {
  const state = await until(
    readOwner,
    value => value.running && value.visible === visible,
    message,
    timeoutMs
  )
  assert.equal(state.contentsId, initial.contentsId, 'Host-owned workbench contents changed')
  assert.equal(state.url, initial.url, 'Host-owned workbench URL changed')
  assert.equal(state.presentation, 'tab')
}

async function verifyMicrophoneDiagnostics(control, origin) {
  const capability = 'deviceDiagnostics.microphone'
  const initial = await invoke(control, origin, capability)
  assert.equal(initial.schemaVersion, 1)
  assert.equal(initial.platform, process.platform)
  assert.equal(initial.inputDeviceKind, 'unknown')
  assert.ok(Number.isFinite(Date.parse(initial.checkedAt)))
  assert.ok(['ok', 'blocked', 'warning', 'unknown', 'unsupported'].includes(initial.status))
  if (process.platform === 'darwin') {
    assert.notEqual(initial.status, 'unsupported')
    assert.ok(['open', 'closed', 'not-present'].includes(initial.checks.lidState))
    for (const signature of [initial.checks.appSignature, initial.checks.audioHelperSignature]) {
      assert.equal(typeof signature.hardenedRuntime, 'boolean')
      assert.equal(typeof signature.audioInputEntitlement, 'boolean')
    }
    assert.equal(typeof initial.checks.usageDescriptionPresent, 'boolean')
  } else {
    assert.equal(initial.code, 'MICROPHONE_DIAGNOSTICS_UNSUPPORTED')
  }
  const invalid = await invokeFailure(control, origin, capability, { inputDeviceKind: 'default' })
  assert.equal(invalid.code, 'invalid_params')
  const recovered = await invoke(control, origin, capability, { inputDeviceKind: 'external' })
  assert.equal(recovered.inputDeviceKind, 'external')
  assert.equal(recovered.checks.permission, initial.checks.permission)
  assert.equal(
    recovered.issues.some(issue => issue.code.includes('LID_CLOSED')),
    false
  )
  return { initial, invalid, recovered }
}

export function createDesktopScenario({ resultDir, uiTimeoutMs }) {
  return {
    async verify(control) {
      const origin = await control.command('getLocationOrigin', 'body')
      const creating = invoke(control, origin, 'smartApps.createDirectory', {
        parentPath: resultDir,
        name: 'dsh-owner-capture-bridge',
        displayName: 'DSH owner capture bridge',
        description: 'Desktop E2E fixture for scoped Smart App capture',
        template: 'web',
      })
      void creating.catch(() => {})
      await confirmHarnessInstallation(control, uiTimeoutMs)
      const workbench = await creating
      assert.ok(workbench?.id, 'Native installation confirmation did not produce a workbench')

      try {
        await invoke(control, origin, 'smartApps.configure', {
          installationId: workbench.id,
          presentation: 'tab',
        })
        await enableExperimentalFeatures(control)
        await control.command('navigate', 'body', {
          value: '/sites?app_type=smart_app&view=owned',
        })
        const modelSelector = `[data-testid="harness-app-model-${workbench.id}"]`
        await control.command('waitFor', modelSelector, {
          enabled: true,
          text: MODEL_LABEL,
        })
        await control.command('select', modelSelector, {
          by: 'label',
          value: MODEL_LABEL,
        })
        const startSelector = `[data-testid="harness-app-start-${workbench.id}"]`
        await control.command('waitFor', startSelector, { enabled: true })
        const previousTabTestId = await control.command(
          'getAttribute',
          '[data-testid^="workspace-tab-select-"][aria-selected="true"]',
          { value: 'data-testid' }
        )
        assert.ok(previousTabTestId, 'The workbench did not have an active workspace tab')
        await control.command('clickWhenEnabled', startSelector)
        const readOwner = async () =>
          JSON.parse(
            await control.command('workbenchApp', 'body', {
              value: JSON.stringify({ action: 'snapshot', id: workbench.id }),
            })
          )
        const owner = await until(
          readOwner,
          state =>
            state.running &&
            state.visible &&
            Number.isInteger(state.contentsId) &&
            state.contentsId > 0 &&
            state.presentation === 'tab' &&
            URL.canParse(state.url) &&
            /^https?:$/.test(new URL(state.url).protocol),
          'The Host-owned workbench HTTP page did not become visible',
          600_000
        )
        const appView = `[data-testid="app-iframe-harness-${workbench.id}"]`
        await control.command('waitFor', appView)
        const ownerTabId = await control.command('getAttribute', appView, {
          value: 'data-workspace-tab-id',
        })
        assert.ok(ownerTabId, 'The Smart App did not expose its workspace tab')
        const ownerTabSelector = `[data-testid="workspace-tab-select-${ownerTabId}"]`

        const workbenchOrigin = new URL(owner.url).origin
        assert.notEqual(
          workbenchOrigin,
          origin,
          'Workbench capture must use its scoped Host origin'
        )
        const microphoneDiagnostics = {
          core: await verifyMicrophoneDiagnostics(control, origin),
          workbench: await verifyMicrophoneDiagnostics(control, workbenchOrigin),
        }
        const capabilities = await invoke(control, workbenchOrigin, 'dshCapture.capabilities')
        assert.deepEqual(capabilities, { available: true })

        const capture = await invoke(control, workbenchOrigin, 'dshCapture.ownerRect', {
          x: 0,
          y: 0,
          width: 128,
          height: 96,
        })
        assert.match(capture.dataUrl, /^data:image\/png;base64,/)

        const invalid = await invokeFailure(control, workbenchOrigin, 'dshCapture.ownerRect', {
          x: -1,
          y: 0,
          width: 128,
          height: 96,
        })
        assert.equal(invalid.code, 'invalid_params')

        // Wait for the native surface to follow the renderer's selected tab.
        await control.command('click', `[data-testid="${previousTabTestId}"]`)
        await control.command('waitFor', `${ownerTabSelector}[aria-selected="false"]`)
        await waitForOwnerVisibility(
          readOwner,
          owner,
          false,
          'Switching tabs did not hide the Smart App owner view',
          uiTimeoutMs
        )
        assert.deepEqual(await invoke(control, workbenchOrigin, 'dshCapture.capabilities'), {
          available: false,
        })
        const hidden = await invokeFailure(control, workbenchOrigin, 'dshCapture.ownerRect', {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        })
        assert.equal(hidden.code, 'owner_view_hidden')

        await control.command('click', ownerTabSelector)
        await control.command('waitFor', `${ownerTabSelector}[aria-selected="true"]`)
        await waitForOwnerVisibility(
          readOwner,
          owner,
          true,
          'Returning to the Smart App did not restore its owner view',
          uiTimeoutMs
        )
        assert.deepEqual(await invoke(control, workbenchOrigin, 'dshCapture.capabilities'), {
          available: true,
        })
        const recovered = await invoke(control, workbenchOrigin, 'dshCapture.ownerRect', {
          x: 0,
          y: 0,
          width: 128,
          height: 96,
        })
        assert.match(recovered.dataUrl, /^data:image\/png;base64,/)

        await writeFile(
          join(resultDir, 'dsh-owner-capture.json'),
          `${JSON.stringify({ captured: true, invalidRejected: true, hiddenRejected: true, captureRecovered: true, microphoneDiagnostics }, null, 2)}\n`,
          'utf8'
        )
      } finally {
        try {
          await invoke(control, origin, 'smartApps.stop', { installationId: workbench.id })
        } finally {
          await invoke(control, origin, 'smartApps.delete', {
            installationId: workbench.id,
            deleteData: true,
          })
        }
      }
    },
  }
}
