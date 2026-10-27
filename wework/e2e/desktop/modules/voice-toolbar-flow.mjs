import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PACKAGE = '@wework-e2e/speech-model'
const PROVIDER = 'voice-toolbar-model'
const VOICE = '[data-testid="composer-voice-input"]'
const ACTIVE = `${VOICE} [data-voice-activity]`
const LEFT_ACTIONS = [
  '[data-testid="add-context-button"]',
  '[data-testid="composer-plugin-picker-button"]',
  '[data-testid="quick-phrase-button"]',
]

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
  ctx.effect(() => ctx.speechToText.register({
    info: { id: '${PROVIDER}', name: 'Toolbar speech model', location: 'cloud', languages: ['auto'] },
    transcribe: async () => { throw new Error('Cancelled recordings must never reach inference') },
  }))
}
`
  )
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await fetch(`${origin}/wework/electron-host/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'runtime.installCoreDshPlugin',
      params: { spec: `file:${directory}` },
    }),
  })
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
  await control.command('click', `${VOICE} button`)
  await control.command('waitFor', '[role="dialog"] button[data-modal-autofocus]')
  await control.command('click', '[role="dialog"] button[data-modal-autofocus]')
  const provider = '[data-testid="voice-input-setup"] select:first-of-type'
  await control.command('waitFor', `${provider} option[value="${PROVIDER}"]`)
  await control.command('select', provider, { value: PROVIDER })
  await control.command('click', '[data-testid="voice-input-setup-close"]')
  await control.command('waitFor', `${VOICE} button:not([aria-haspopup])`)
  await assertToolbar(control, false)

  // Enter the real capture/request/error row even on machines without a mic.
  // Do not replace getUserMedia or recording with a fake device.
  await control.command('click', `${VOICE} button`)
  await assertToolbar(control, true)
  await control.command('click', `${ACTIVE} button:first-of-type`)
  await assertToolbar(control, false)

  await control.command('click', `${VOICE} button`)
  await assertToolbar(control, true)
  await control.command('click', `${ACTIVE} button:first-of-type`)
  await assertToolbar(control, false)
}
