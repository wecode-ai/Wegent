import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const HOST_INVOKE_PATH = '/wework/electron-host/v1/invoke'
const MODEL_LABEL = 'Desktop E2E Chat'

async function postInvoke(origin, capability, params) {
  const endpoint = `${origin}${HOST_INVOKE_PATH}`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
  })
  return { response, payload: await response.json() }
}

async function invoke(origin, capability, params = {}) {
  const { response, payload } = await postInvoke(origin, capability, params)
  assert.equal(
    response.ok,
    true,
    `${capability} returned ${payload.error?.message ?? response.status}`
  )
  assert.equal(payload.ok, true, `${capability} failed: ${payload.error?.message}`)
  return payload.result
}

async function invokeFailure(origin, capability, params = {}) {
  const { response, payload } = await postInvoke(origin, capability, params)
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

export function createDesktopScenario({ resultDir }) {
  return {
    async verify(control) {
      const origin = await control.command('getLocationOrigin', 'body')
      const workbench = await invoke(origin, 'smartApps.createDirectory', {
        parentPath: resultDir,
        name: 'dsh-owner-capture-bridge',
        displayName: 'DSH owner capture bridge',
        description: 'Desktop E2E fixture for scoped Smart App capture',
        template: 'web',
      })

      try {
        await enableExperimentalFeatures(control)
        await control.command('navigate', 'body', {
          value: '/sites?app_type=smart_app&view=owned',
        })
        const modelSelector = `[data-testid="harness-app-model-${workbench.id}"]`
        await control.command('waitFor', modelSelector, { enabled: true })
        await control.command('select', modelSelector, {
          by: 'label',
          value: MODEL_LABEL,
        })
        const startSelector = `[data-testid="harness-app-start-${workbench.id}"]`
        await control.command('waitFor', startSelector, { enabled: true })
        await control.command('clickWhenEnabled', startSelector)
        const appView = `[data-testid="app-iframe-harness-${workbench.id}"]`
        await control.command('waitFor', appView, { timeoutMs: 600_000 })
        const webUrl = await control.command('getAttribute', appView, { value: 'data-src' })
        const ownerLabel = await control.command('getAttribute', appView, {
          value: 'data-embedded-browser-label',
        })
        assert.ok(webUrl, 'Workbench DSH did not expose a URL')
        assert.equal(ownerLabel, `smart-app:${workbench.id}`)

        const workbenchOrigin = new URL(webUrl).origin
        const capabilities = await invoke(workbenchOrigin, 'dshCapture.capabilities')
        assert.deepEqual(capabilities, { available: true })

        const capture = await invoke(workbenchOrigin, 'dshCapture.ownerRect', {
          x: 0,
          y: 0,
          width: 128,
          height: 96,
        })
        assert.match(capture.dataUrl, /^data:image\/png;base64,/)

        const invalid = await invokeFailure(workbenchOrigin, 'dshCapture.ownerRect', {
          x: -1,
          y: 0,
          width: 128,
          height: 96,
        })
        assert.equal(invalid.code, 'invalid_params')

        await invoke(origin, 'browser.setBounds', {
          label: ownerLabel,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          visible: false,
        })
        const hidden = await invokeFailure(workbenchOrigin, 'dshCapture.ownerRect', {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        })
        assert.equal(hidden.code, 'owner_view_hidden')

        await writeFile(
          join(resultDir, 'dsh-owner-capture.json'),
          `${JSON.stringify({ captured: true, invalidRejected: true, hiddenRejected: true }, null, 2)}\n`,
          'utf8'
        )
      } finally {
        await invoke(origin, 'smartApps.stop', { installationId: workbench.id })
        await invoke(origin, 'smartApps.delete', {
          installationId: workbench.id,
          deleteData: true,
        })
      }
    },
  }
}
