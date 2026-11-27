import assert from 'node:assert/strict'

export async function waitForDesktopScenarioStartup({ control, scenario, waitForReady }) {
  const ready = await waitForReady()
  assert.match(
    String(ready.location ?? ''),
    /^https?:/,
    'The Electron desktop controller did not connect from its local renderer origin'
  )
  await scenario?.beforeWorkbenchSetup?.(control)
  return ready
}
