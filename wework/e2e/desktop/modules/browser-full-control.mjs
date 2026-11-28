import assert from 'node:assert/strict'
import { waitForAttribute } from './workspace-flows.mjs'

const TOGGLE = '[data-testid="browser-full-control-toggle"]'
const APPROVE = '[data-testid="workspace-browser-agent-approval-approve-button"]'
const REJECT = '[data-testid="workspace-browser-agent-approval-reject-button"]'

export async function readEditorFixtureState(control, label, timeoutMs) {
  const state = await control.command('getEmbeddedBrowserWindowValue', 'body', {
    value: JSON.stringify({ label, key: '__weworkE2eEditorState' }),
    timeoutMs,
  })
  assert.ok(state, 'The editor fixture must expose its current DOM state')
  return JSON.parse(state)
}

export async function beginBrowserApproval(control, invoke, selector, timeoutMs) {
  let outcome
  const pending = invoke().then(
    result => (outcome = { result }),
    error => (outcome = { error })
  )
  try {
    await control.command('waitFor', selector, { timeoutMs })
  } catch (error) {
    if (outcome && 'error' in outcome) throw outcome.error
    throw error
  }
  const approvalId = await control.command('getAttribute', selector, { value: 'data-approval-id' })
  assert.ok(approvalId, 'The visible approval must identify its original operation')
  if (outcome && 'error' in outcome) throw outcome.error
  assert.equal(outcome, undefined, 'The original tool call must await the user decision')
  return {
    approvalId,
    completed: () => outcome !== undefined,
    async result() {
      const settled = await pending
      if ('error' in settled) throw settled.error
      return settled.result
    },
  }
}

export async function verifyBrowserFullControl(control, bridgeCall, fill, label, timeoutMs) {
  const openSettings = async () => {
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    await control.command('click', '[data-testid="settings-nav-browser"]')
    await control.command('waitFor', TOGGLE + ':not(:disabled)', { timeoutMs })
  }
  const setEnabled = async enabled => {
    await openSettings()
    await control.command('click', TOGGLE)
    await waitForAttribute(
      control,
      TOGGLE,
      'aria-checked',
      String(enabled),
      'Full control was not saved'
    )
    await control.command('click', '[data-testid="settings-back-button"]')
  }
  const readEditor = () => readEditorFixtureState(control, label, timeoutMs)
  await openSettings()
  await waitForAttribute(
    control,
    TOGGLE,
    'aria-checked',
    'false',
    'Full control must default to off'
  )
  await control.command('click', TOGGLE)
  await waitForAttribute(control, TOGGLE, 'aria-checked', 'true', 'Full control was not enabled')
  await control.command('click', '[data-testid="settings-back-button"]')
  try {
    const before = await readEditor()
    const result = await fill({ selector: '#script-editor', text: 'full control edit' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(await readEditor(), { text: 'full control edit', edits: before.edits + 1 })
    await control.command('waitFor', APPROVE, { visible: false, timeoutMs })
    await openSettings()
    await waitForAttribute(control, TOGGLE, 'aria-checked', 'true', 'Full control did not persist')
    await control.command('click', '[data-testid="settings-back-button"]')
  } finally {
    await setEnabled(false)
  }
  const pending = await beginBrowserApproval(
    control,
    () =>
      bridgeCall({
        action: 'fill',
        selector: '#script-editor',
        text: 'requires confirmation again',
      }),
    REJECT,
    timeoutMs
  )
  await control.command('click', REJECT)
  const rejected = await pending.result()
  assert.equal(rejected.error?.code, 'approval_rejected', JSON.stringify(rejected))
  assert.equal((await readEditor()).text, 'full control edit')
}
