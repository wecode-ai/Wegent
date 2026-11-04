import assert from 'node:assert/strict'
import { waitForAttribute } from './workspace-flows.mjs'

const TOGGLE = '[data-testid="browser-full-control-toggle"]'
const APPROVE = '[data-testid="workspace-browser-agent-approval-approve-button"]'
const REJECT = '[data-testid="workspace-browser-agent-approval-reject-button"]'

export async function verifyBrowserFullControl(control, bridgeCall, fill, timeoutMs) {
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
  const readEditor = async () => {
    const result = await bridgeCall({
      action: 'evaluate',
      expression:
        '({text: document.querySelector("#script-editor").value, edits: Number(document.querySelector("#script-editor").dataset.edits || 0)})',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
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
  const pending = bridgeCall({
    action: 'fill',
    selector: '#script-editor',
    text: 'requires confirmation again',
  })
  await control.command('waitFor', REJECT, { timeoutMs })
  await control.command('click', REJECT)
  const rejected = await pending
  assert.equal(rejected.error?.code, 'approval_rejected', JSON.stringify(rejected))
  assert.equal((await readEditor()).text, 'full control edit')
}
