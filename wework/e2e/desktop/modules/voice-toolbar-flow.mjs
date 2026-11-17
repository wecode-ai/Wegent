import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchLocalRuntime } from './runtime-request.mjs'
import { withNativePluginDecision } from './native-plugin-approval.mjs'
import { WORKBENCH_READY_TIMEOUT_MS, withTimeout } from './shared.mjs'

const PACKAGE = '@wework-e2e/speech-model'
const PROVIDER = 'voice-toolbar-model'
const VOICE = '[data-testid="composer-voice-input"]'
const ACTIVE = `${VOICE} [data-voice-activity]`
const LEFT_ACTIONS = [
  '[data-testid="add-context-button"]',
  '[data-testid="composer-plugin-picker-button"]',
  '[data-testid="quick-phrase-button"]',
]

export async function waitForVoiceToolbarReady(control, report = console.log) {
  try {
    await control.command('waitFor', `${VOICE} button:not([aria-haspopup])`)
  } catch (error) {
    try {
      const observations = {
        mounted: ['getElementCount', VOICE],
        buttons: ['getElementCount', `${VOICE} button`],
        readyButtons: ['getElementCount', `${VOICE} button:not([aria-haspopup])`],
        active: ['getElementCount', ACTIVE],
        popup: ['getAttribute', `${VOICE} button`, { value: 'aria-haspopup' }],
        label: ['getAttribute', `${VOICE} button`, { value: 'aria-label' }],
        title: ['getAttribute', `${VOICE} button`, { value: 'title' }],
      }
      const state = await withTimeout(
        Promise.all(
          Object.entries(observations).map(async ([key, command]) => [
            key,
            String(await control.command(...command)).slice(0, 256),
          ])
        ),
        1_000,
        'Voice toolbar failure diagnostics did not complete'
      )
      report(`[voice-toolbar-readiness] ${JSON.stringify(Object.fromEntries(state))}`)
    } catch {
      // Diagnostics must preserve the original readiness failure.
    }
    throw error
  }
}

async function installSpeechModel(control, resultDir) {
  const directory = join(resultDir, 'speech-model')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
  )
  await writeFile(
    join(directory, 'cordis.patch.yml'),
    `- insert:\n    - id: voice-toolbar-model\n      name: '${PACKAGE}'\n`
  )
  // Only inference is substituted. The speech registry, readiness stream,
  // official voice component, microphone capture and cancellation stay real.
  await writeFile(
    join(directory, 'index.js'),
    `export const inject = ['speechToText']
export function apply(ctx) {
  const speech = ctx.speechToText
  const originalConfigure = speech.configure
  const observedConfigure = async function (patch) {
    const startedAt = Date.now()
    console.log('[voice-selection]', { phase: 'started', pid: process.pid })
    try {
      const result = await originalConfigure.call(this, patch)
      console.log('[voice-selection]', { phase: 'completed', elapsedMs: Date.now() - startedAt, selection: this.snapshot().selection })
      return result
    } catch (error) {
      console.error('[voice-selection]', { phase: 'failed', elapsedMs: Date.now() - startedAt, message: String(error?.message ?? error) })
      throw error
    }
  }
  speech.configure = observedConfigure
  ctx.effect(() => () => { if (speech.configure === observedConfigure) speech.configure = originalConfigure })
  ctx.effect(() => ctx.speechToText.register({
    info: { id: '${PROVIDER}', name: 'Toolbar speech model', location: 'cloud', languages: ['auto'] },
    transcribe: async () => { throw new Error('Cancelled recordings must never reach inference') },
  }))
}
`
  )
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await withNativePluginDecision(control, () =>
    fetchLocalRuntime(control, `${origin}/wework/electron-host/v1/invoke`, {
      method: 'POST',
      // Installing a real plugin snapshots the profile, runs pnpm and validates
      // the result. These serial phases can exceed the ordinary UI step budget.
      timeoutMs: 60_000,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'runtime.installCoreDshPlugin',
        params: { spec: `file:${directory}` },
      }),
    })
  )
  const payload = await response.json()
  assert.equal(response.ok, true, JSON.stringify(payload))
  assert.equal(payload.ok, true, JSON.stringify(payload))
  assert.ok(payload.result.some(plugin => plugin.name === PACKAGE && plugin.enabled))
}

async function assertToolbar(control, active) {
  await control.command('waitFor', ACTIVE, { visible: active })
  await control.command('waitFor', `${VOICE} button`, { visible: true })
  for (const selector of LEFT_ACTIONS) {
    await control.command('waitFor', selector, { visible: !active })
  }
  await control.command('waitFor', '[data-testid="model-selector-button"]', { visible: true })
}

export async function verifyVoiceToolbar({ control, resultDir, restartDesktopApp }) {
  await installSpeechModel(control, resultDir)
  await restartDesktopApp()
  await control.command('waitFor', '[data-testid="new-chat-button"]')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', `${VOICE} button:not(:disabled)`)
  await control.command('click', `${VOICE} button`)
  await control.command('waitFor', '[role="dialog"] button[data-modal-autofocus]')
  await control.command('click', '[role="dialog"] button[data-modal-autofocus]')
  const provider = '[data-testid="voice-input-setup"] select:first-of-type'
  await control.command('waitFor', `${provider} option[value="${PROVIDER}"]`)
  await control.command('select', provider, { value: PROVIDER })
  await control.command('click', '[data-testid="voice-input-setup-close"]')
  await waitForVoiceToolbarReady(control)
  await assertToolbar(control, false)

  // Enter the real capture/request/error row even on machines without a mic.
  // Do not replace getUserMedia or recording with a fake device.
  await control.command('click', `${VOICE} button`)
  await assertToolbar(control, true)
  await control.command('click', `${ACTIVE} button:first-of-type`)
  await assertToolbar(control, false)

  for (const [trigger, menu] of [
    ['add-context-button', 'add-context-menu'],
    ['quick-phrase-button', 'quick-phrase-menu'],
    ['composer-plugin-picker-button', 'composer-plugin-picker'],
  ]) {
    await control.command('click', `[data-testid="${trigger}"]`)
    await control.command('waitFor', `[data-testid="${menu}"]`, { visible: true })
    await control.command('nativePress', `${VOICE} button`, { key: 'Enter' })
    await assertToolbar(control, true)
    await control.command('waitFor', `[data-testid="${menu}"]`, { visible: false })
    await control.command('click', `${ACTIVE} button:first-of-type`)
    await assertToolbar(control, false)
  }
}
